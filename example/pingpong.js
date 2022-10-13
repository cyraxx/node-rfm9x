const rfm9x = require('rfm9x');

async function main() {
    const device = new rfm9x();

    // Initialize the LoRa module. All options can be omitted and default values will be used.
    await device.init({
        frequencyMhz: 868,
        bandwidthHz: 500000,
        codingRate: 5,
        spreadingFactor: 7,
    });

    // Listen to the receive event that is emitted whenever a valid LoRa packet is received.
    device.on('receive', packet => {
        // Print out the packet contents and metadata for clarity.
        console.dir(packet);

        // If we received a PING, respond with a PONG.
        if (packet.payload.toString() == 'PING') {
            await device.send(Buffer.from('PONG'));

            // After a transmission is finished, receiving mode needs to be re-enabled.
            await device.startReceive();
        }
    });

    // Enable receiving mode.
    await device.startReceive();
}

main();
