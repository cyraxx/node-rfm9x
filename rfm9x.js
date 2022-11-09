const EventEmitter = require('node:events');
const spi = require('spi-device');
const onoff = require('onoff');
const usleep = require('usleep');

const defaultOptions = {
    frequencyMhz: 915,
    preambleLength: 8,
    bandwidthHz: 500000,
    codingRate: 5,
    spreadingFactor: 7,
    enableCrcChecking: false,
    txPowerDb: 23,
    enableAgc: false,
    resetPin: 25,
    dio0Pin: 22,
    dio1Pin: 23, // Currently not used
    dio2Pin: 24, // Currently not used
    spiSpeedHz: 100000,
    txTimeoutMs: 2000,
}

const REGISTERS = {
    FIFO: 0x00,
    OP_MODE: 0x01,
    FRF_MSB: 0x06,
    FRF_MID: 0x07,
    FRF_LSB: 0x08,
    PA_CONFIG: 0x09,
    FIFO_ADDR_PTR: 0x0D,
    FIFO_TX_BASE_ADDR: 0x0E,
    FIFO_RX_BASE_ADDR: 0x0F,
    IRQ_FLAGS: 0x12,
    RX_NB_BYTES: 0x13,
    PKT_SNR_VALUE: 0x19,
    PKT_RSSI_VALUE: 0x1A,
    MODEM_CONFIG_1: 0x1D,
    MODEM_CONFIG_2: 0x1E,
    PREAMBLE_MSB: 0x20,
    PREAMBLE_LSB: 0x21,
    PAYLOAD_LENGTH: 0x22,
    MODEM_CONFIG_3: 0x26,
    DIO_MAPPING_1: 0x40,
    DIO_MAPPING_2: 0x41,
    VERSION: 0x42,
    PA_DAC: 0x4D,
};

const OP_MODES = {
    SLEEP: 0b000,
    STANDBY: 0b001,
    TRANSMIT: 0b011,
    RXCONT: 0b101,
    RXSINGLE: 0b110,
    CAD: 0b111,
};

const DIO0_MAPPINGS = {
    RX_DONE: 0b00,
    TX_DONE: 0b01,
    CAD_DONE: 0b10,
}

const BANDWIDTHS = [7800, 10400, 15600, 20800, 31250, 41700, 62500, 125000, 250000];
const BW_REG_2F_OFFSETS = [0x48, 0x44, 0x44, 0x44, 0x44, 0x44, 0x40, 0x40, 0x40];

const RF95_FXOSC = 32000000;
const RF95_FSTEP = RF95_FXOSC / 524288;

const BITMASKS = [
    0b00000001,
    0b00000011,
    0b00000111,
    0b00001111,
    0b00011111,
    0b00111111,
    0b01111111,
];

module.exports = class RFM9x extends EventEmitter {
    debug = false;
    #options;
    #isReceiving = false;

    #spiDevice;
    #resetGpio;
    #dio0Gpio;

    async init(options) {
        options = {...defaultOptions, ...options};
        if (this.debug) console.dir(options);
        this.#options = options;

        this.#spiDevice = await new Promise((resolve, reject) => {
            const dev = spi.open(0, 1, {maxSpeedHz: options.spiSpeedHz}, err => {
                if (err) reject(err);
                else resolve(dev);
            });
        });
        this.#resetGpio = new onoff.Gpio(options.resetPin, 'high');
        this.#dio0Gpio = new onoff.Gpio(options.dio0Pin, 'in');
        this.#dio0Gpio.setEdge('rising');

        await this.#reset();

        const version = await this.getVersion();
        if (version === 0) {
            throw new Error('RFM9x module not detected');
        } else if (version != 0x12) {
            throw new Error('RFM9x version not supported');
        }

        // Switch to sleep mode and set LoRa mode (can only be done in sleep mode)
        await this.#setOperatingMode(OP_MODES.SLEEP);
        await usleep.msleep(10);
        await this.#setLoRaMode(true);

        // Perform a sanity check
        if (await this.#getOperatingMode() != OP_MODES.SLEEP || !(await this.#getLoRaMode())) {
            throw new Error('Communication error: Readback of module configuration failed');
        }

        // Clear low frequency mode if frequency is high
        if (options.frequencyMhz > 525) await this.#setLowFrequencyMode(false);

        // Setup entire 256 byte FIFO
        await this.#setFIFOBaseAddress(0, 0);

        // Switch back to standby mode and set parameters
        await this.#setOperatingMode(OP_MODES.STANDBY);
        await this.#setPreambleLength(options.preambleLength);
        await this.#setFrequencyAndBandwidth(options.frequencyMhz, options.bandwidthHz);
        await this.#setSpreadingFactor(options.spreadingFactor);
        await this.#setCodingRate(options.codingRate);
        await this.#setRxCrc(options.enableCrcChecking);
        await this.#setAgc(options.enableAgc);
        await this.#setTxPower(options.txPowerDb);
    }

    async #reset() {
        await this.#resetGpio.write(0);
        await usleep.usleep(100);
        await this.#resetGpio.write(1);
        await usleep.msleep(5);
    }

    async startReceive() {
        await this.stopReceive();
        await this.#writeByte(REGISTERS.FIFO_ADDR_PTR, 0);
        await this.#writeBits(REGISTERS.DIO_MAPPING_1, 2, 6, DIO0_MAPPINGS.RX_DONE);

        this.#dio0Gpio.watch(async (err, value) => {
            if (value === 1) {
                const flags = await this.#readBits(REGISTERS.IRQ_FLAGS, 3, 4);
                await this.#writeByte(REGISTERS.IRQ_FLAGS, 0xFF);

                if (flags !== 0b0101) {
                    this.emit('receiveError');
                    return;
                }

                const numBytes = await this.#readByte(REGISTERS.RX_NB_BYTES);
                await this.#writeByte(REGISTERS.FIFO_ADDR_PTR, 0);
                const rxbuf = await this.#readBuffer(REGISTERS.FIFO, numBytes);

                const snr = await this.#readByte(REGISTERS.PKT_SNR_VALUE);
                const rssi = await this.#readByte(REGISTERS.PKT_RSSI_VALUE);
                this.emit('receive', {
                    payload: rxbuf,
                    rssiDb: -137 + rssi,
                    snrDb: (snr > 127 ? (256 - snr) * -1 : snr) / 4,
                });;
            }
        });

        await this.#setOperatingMode(OP_MODES.RXCONT);
    }

    async stopReceive() {
        await this.#setOperatingMode(OP_MODES.STANDBY);
        this.#dio0Gpio.unwatchAll();
    }

    async send(payload) {
        if (!payload instanceof Buffer) throw new TypeError('Payload needs to be a Buffer');
        if (payload.length < 1) throw new RangeError('Empty payload supplied');
        if (payload.length > 255) throw new RangeError('Payload too long');

        await this.stopReceive();
        await this.#writeByte(REGISTERS.FIFO_ADDR_PTR, 0);
        await this.#writeBuffer(REGISTERS.FIFO, payload);
        await this.#writeByte(REGISTERS.PAYLOAD_LENGTH, payload.length);
        await this.#writeBits(REGISTERS.DIO_MAPPING_1, 2, 6, DIO0_MAPPINGS.TX_DONE);

        const promise = new Promise((resolve, reject) => {
            const rejectTimeout = setTimeout(
                () => {
                    this.#dio0Gpio.unwatchAll();
                    reject(new Error(`Send timeout of ${this.#options.txTimeoutMs}ms expired`));
                },
                this.#options.txTimeoutMs
            );
            this.#dio0Gpio.watch(async (err, value) => {
                if (value === 1) {
                    clearTimeout(rejectTimeout);
                    await this.#writeByte(REGISTERS.IRQ_FLAGS, 0xFF);
                    resolve();
                }
            });
        });

        await this.#setOperatingMode(OP_MODES.TRANSMIT);

        return promise;
    }

    async getVersion() {
        return this.#readByte(REGISTERS.VERSION);
    }

    async #getOperatingMode() {
        return this.#readBits(REGISTERS.OP_MODE, 3, 0);
    }

    async #setOperatingMode(mode) {
        await this.#writeBits(REGISTERS.OP_MODE, 3, 0, mode);
    }

    async #getLoRaMode() {
        return (await this.#readBits(REGISTERS.OP_MODE, 1, 7)) === 1;
    }

    async #setLoRaMode(isLoRa) {
        await this.#writeBits(REGISTERS.OP_MODE, 1, 7, isLoRa ? 1 : 0);
    }

    async #setLowFrequencyMode(isLowFrequency) {
        await this.#writeBits(REGISTERS.OP_MODE, 1, 3, isLowFrequency ? 1 :0);
    }

    async #setFIFOBaseAddress(txBaseAddress, rxBaseAddress) {
        await this.#writeByte(REGISTERS.FIFO_TX_BASE_ADDR, txBaseAddress);
        await this.#writeByte(REGISTERS.FIFO_RX_BASE_ADDR, rxBaseAddress);
    }

    async #setFrequencyAndBandwidth(frequencyMhz, bandwidthHz) {
        // Offset frequency value to prevent spurious reception
        // (Semtech SX1276 errata note 2.3)
        let frequencyHz = frequencyMhz * 1000000;
        if (bandwidthHz < 62500) frequencyHz += bandwidthHz;

        const frf = Math.round(frequencyHz / RF95_FSTEP) & 0xFFFFFF;

        await this.#writeByte(REGISTERS.FRF_MSB, frf >> 16);
        await this.#writeByte(REGISTERS.FRF_MID, (frf >> 8) & 0xFF);
        await this.#writeByte(REGISTERS.FRF_LSB, frf & 0xFF);

        // Find the lowest bandwidth setting that is greater than or equal to the desired bandwidth.
        // bandwidthId will be set to the length of the array if none is found.
        let bandwidthId;
        for (bandwidthId = 0; bandwidthId < BANDWIDTHS.length; bandwidthId++) {
            if (bandwidthHz <= BANDWIDTHS[bandwidthId]) break;
        }

        await this.#writeBits(REGISTERS.MODEM_CONFIG_1, 4, 4, bandwidthId);

        // Receiver Spurious Reception of LoRa Signal
        // (Semtech SX1276 errata note 2.3)
        if (bandwidthId < BANDWIDTHS.length) {
            await this.#writeBits(0x31, 1, 7, 0);
            await this.#writeByte(0x2F, BW_REG_2F_OFFSETS[bandwidthId]);
            await this.#writeByte(0x30, 0);
        } else {
            await this.#writeBits(0x31, 1, 7, 1);
        }

        // Sensitivity Optimization with 500 kHz Bandwidth
        // (Semtech SX1276 errata note 2.1)
        if (bandwidthId == BANDWIDTHS.length) {
            if (frequencyMhz >= 862) {
                await this.#writeByte(0x36, 0x02);
                await this.#writeByte(0x3A, 0x64);
            } else if (frequencyMhz <= 525) {
                await this.#writeByte(0x36, 0x02);
                await this.#writeByte(0x3A, 0x7F);
            }
        } else {
            await this.#writeByte(0x36, 0x03);
        }
    }

    async #setPreambleLength(preambleLength) {
        await this.#writeByte(REGISTERS.PREAMBLE_MSB, (preambleLength >> 8) & 0xFF);
        await this.#writeByte(REGISTERS.PREAMBLE_LSB, preambleLength & 0xFF);
    }

    async #setSpreadingFactor(spreadingFactor) {
        if (spreadingFactor < 6 || spreadingFactor > 12) {
            throw new RangeError('Invalid spreading factor');
        }

        await this.#writeBits(REGISTERS.MODEM_CONFIG_2, 4, 4, spreadingFactor);

        if (spreadingFactor === 6) {
            await this.#writeBits(0x31, 3, 0, 0b101);
            await this.#writeByte(0x37, 0x0C);
        }
    }

    async #setCodingRate(codingRate) {
        if (codingRate < 5 || codingRate > 8) {
            throw new RangeError('Invalid coding rate');
        }

        await this.#writeBits(REGISTERS.MODEM_CONFIG_1, 3, 1, codingRate - 4);
    }

    async #setRxCrc(enableCrc) {
        await this.#writeBits(REGISTERS.MODEM_CONFIG_2, 1, 2, enableCrc ? 1 : 0);
    }

    async #setAgc(enableAgc) {
        await this.#writeBits(REGISTERS.MODEM_CONFIG_3, 1, 2, enableAgc ? 1 : 0);
    }

    async #setTxPower(txPowerDb) {
        // Currently only high power mode (PA_BOOST) is supported
        if (txPowerDb < 5 || txPowerDb > 23) {
            throw new RangeError('Invalid TX power value');
        }

        if (txPowerDb > 20) {
            await this.#writeByte(REGISTERS.PA_DAC, 0x87);
            txPowerDb -= 3;
        } else {
            await this.#writeByte(REGISTERS.PA_DAC, 0x84);
        }

        await this.#writeBits(REGISTERS.PA_CONFIG, 1, 7, 1);
        await this.#writeBits(REGISTERS.PA_CONFIG, 4, 0, txPowerDb - 5)
    }

    async #readByte(address) {
        const rxbuf = await this.#readBuffer(address, 1);
        return rxbuf[0];
    }

    async #readBuffer(address, length) {
        const txbuf = Buffer.alloc(length + 1);
        txbuf[0] = address & 0x7F;
        const rxbuf = Buffer.alloc(txbuf.length);

        await new Promise((resolve, reject) => {
            this.#spiDevice.transfer([{
                sendBuffer: txbuf,
                receiveBuffer: rxbuf,
                byteLength: txbuf.length
            }], err => {
                if (err) reject(err);
                else resolve();
            });
        });

        const result = rxbuf.subarray(1);
        if (this.debug) console.log(`${this.#getRegisterName(address)} <= ${result.join(' ')}`);
        return result;
    }

    async #writeByte(address, val) {
        await this.#writeBuffer(address, Buffer.from([val & 0xFF]));
    }

    async #writeBuffer(address, buffer) {
        const txbuf = Buffer.concat([
            Buffer.from([(address & 0x7F) | 0x80]),
            buffer
        ]);

        await new Promise((resolve, reject) => {
            this.#spiDevice.transfer([{
                sendBuffer: txbuf,
                byteLength: txbuf.length
            }], err => {
                if (err) reject(err);
                else resolve();
            });
        });

        if (this.debug) console.log(`${this.#getRegisterName(address)} => ${buffer.join(' ')}`);
    }

    async #readBits(address, bits, offset) {
        const mask = BITMASKS[bits - 1] << offset;

        const registerValue = await this.#readByte(address);
        return (registerValue & mask) >> offset;
    }

    async #writeBits(address, bits, offset, val) {
        const mask = BITMASKS[bits - 1];
        val &= mask;

        const oldRegisterValue = await this.#readByte(address);
        let registerValue = oldRegisterValue;
        registerValue &= ~(mask << offset);
        registerValue |= val << offset;

        if (registerValue == oldRegisterValue) {
            if (this.debug) console.log(`${this.#getRegisterName(address)} => NOP`);
            return;
        }

        await this.#writeByte(address, registerValue);
    }

    #getRegisterName(address) {
        const registerName = Object.keys(REGISTERS).find(key => REGISTERS[key] === address);
        if (registerName) return registerName;
        return '0x' + address.toString(16).padStart(2, '0');
    }

}
