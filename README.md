# Introduction

Node.js module to interface with RFM9x LoRa wireless modules. Intended for use
with [Adafruit Radio Bonnets](https://learn.adafruit.com/adafruit-radio-bonnets/overview).

The code has only been tested on Raspberry Pi but could technically also work
on other boards supported by onoff and spi-device.

## Acknowledgements

- The [CircuitPython RFM9x module](https://github.com/adafruit/Adafruit_CircuitPython_RFM9x)
was used as a template for most of the logic.
- The [spi-device](https://github.com/fivdi/spi-device) and [onoff](https://github.com/fivdi/onoff)
modules by fivdi made interfacing with the hardware really easy.

# Example

See `example/pingpong.js` for a simple example of receiving and sending data.

# API

The modules exports a single class `RFM9x`.

## Class `RFM9x`

Class representing the LoRa module. The constructor requires no arguments.

```js
const rfm9x = require('rfm9x');
const module = new rfm9x();

await module.init({ ... });
```

---

### Properties

* [`debug`](#debug) - Output SPI debug information

#### `debug`

Set this property to `true` to get all SPI communication printed out to the console.

**Note:** Because `console.log()` calls are synchronous in most circumstances, enabling this can impact
timing! For example, it might cause switching from sending to receiving mode to be slow enough to miss
responses from other nodes.

---

### Methods

* [`init(options)`](#initoptions) - Initialize module and LoRa settings
* [`startReceive()`](#startreceive) - Put the LoRa module in receive mode and enable the `receive` event
* [`stopReceive()`](#stopreceive) - Put the LoRa module in standby mode and stop receiving packets
* [`send(payload)`](#sendpayload) - Send a packet via LoRa
* [`getVersion()`](#getversion) - Get the chip version number from the module

#### `init(options)`

- `options` - Options object (see below). All properties are optional, default values will be
used when omitted.

Initialize module and LoRa settings. Needs to be called before using any of the radio functions.

Returns a Promise that resolves with no value.

The following options are supported:

- `frequencyMhz` - Base frequency in MHz, default: `915`
- `preambleLength` - LoRa preamble length in bytes, default: `8`
- `bandwidthHz` - LoRa bandwidth in Hz, default: `500000`
- `codingRate` - LoRa coding rate, valid values are `5` (4/5) to `8` (4/8), default: `5`
- `spreadingFactor` - LoRa spreading factor, valid values are `6` to `12`, default: `7`
- `enableCrcChecking` - Whether to enable CRC checking on incoming packets, default: `false`
- `txPowerDb` - Transmitter power in dB, valid values are `5` to `23` (currently only high power mode is
supported), default: `23`
- `enableAgc` - Whether to enable Automatic Gain Control, default: `false`
- `resetPin` - Number of the GPIO pin that the RFM9x RESET line is connected to, default: `25`
- `dio0Pin` - Number of the GPIO pin that the RFM9x DIO0 line is connected to, default: `22`
- `dio1Pin` - *Not currently used.* Number of the GPIO pin that the RFM9x DIO1 line is connected to,
default: `23`
- `dio2Pin` - *Not currently used.* Number of the GPIO pin that the RFM9x DIO2 line is connected to,
default: `24`
- `spiSpeedHz` - Speed of the SPI communication in Hz, default: `100000`
- `txTimeoutMs` - Maximum time in milliseconds to wait for a packet transmission to finish, default: `2000`

#### `startReceive()`

Put the LoRa module in receive mode and enable the `receive` event.

Returns a Promise that resolves with no value.

#### `stopReceive()`

Put the LoRa module in standby mode and stop receiving packets.

Returns a Promise that resolves with no value.

#### `send(payload)`

- `payload` - A `Buffer` of up to 255 bytes

Send a packet via LoRa.

Returns a Promise that resolves with no value after the transmission is finished.

**Note:** After transmitting a packet, the module switches into standby mode automatically. If you want to
continue receiving packets after a transmission, you will need to call `startReceive()` after the transmission
completed.

#### `getVersion()`

Get the chip version number from the module.

Returns a Promise that resolves with the version number (one-byte integer).

---

### Events

* [`receive(packet)`](#receivepacket) - Emitted when a LoRa packet has been received
* [`receiveError()`](#receiveerror) - Emitted when an invalid LoRa packet has been received

#### `receive(packet)`

Event that is emitted when a LoRa packet is received.

`packet` is an object containing the following properties:
- `payload` - A `Buffer` containing the packet contents
- `rssiDb` - RSSI of the packet in dB
- `snrDb` - SNR of the packet in dB

#### `receiveError()`

Event that is emitted when a LoRa packet is received but was discarded due to receive errors (e.g. CRC check
failed).
