const mqtt = require('mqtt');

class DeviceSimulator {
  constructor(mac, brokerUrl = 'mqtt://127.0.0.1:1883') {
    this.mac = mac;
    this.brokerUrl = brokerUrl;
    this.client = null;
    this.seq = 0;
    this.state = {};
    this.lastReceivedCommand = null;
    this.offlineMode = false;
    this.noAckMode = false;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.client = mqtt.connect(this.brokerUrl, {
        clientId: `device_sim_${this.mac.replace(/:/g, '')}`,
        clean: true,
        reconnectPeriod: 1000
      });

      this.client.on('connect', () => {
        console.log(`[DEVICE SIM ${this.mac}] Connected to MQTT Broker`);
        // Subscribe to control commands topic
        const controlTopic = `smarthome/${this.mac}/control`;
        this.client.subscribe(controlTopic, { qos: 1 }, (err) => {
          if (err) {
            console.error(`[DEVICE SIM ${this.mac}] Subscription error:`, err);
            reject(err);
          } else {
            console.log(`[DEVICE SIM ${this.mac}] Subscribed to control topic: ${controlTopic}`);
            resolve();
          }
        });
      });

      this.client.on('message', (topic, message) => {
        if (this.offlineMode) return; // Do not respond when offline simulation is active
        try {
          const payload = JSON.parse(message.toString());
          console.log(`[DEVICE SIM ${this.mac}] Received MQTT command:`, payload);
          this.lastReceivedCommand = payload;

          if (this.noAckMode) {
            console.log(`[DEVICE SIM ${this.mac}] No ACK mode active, skipping ACK`);
            return;
          }

          // Simulate processing command
          const { command_id, action, instance, payload: cmdPayload } = payload;
          
          // Respond with ACK
          const ackTopic = `smarthome/${this.mac}/ack`;
          const ackPayload = {
            command_id,
            device_id: this.mac,
            status: 'success',
            timestamp: new Date().toISOString()
          };

          this.client.publish(ackTopic, JSON.stringify(ackPayload), { qos: 1 }, (err) => {
            if (err) {
              console.error(`[DEVICE SIM ${this.mac}] Failed to publish ACK:`, err);
            } else {
              console.log(`[DEVICE SIM ${this.mac}] Sent ACK to topic ${ackTopic}:`, ackPayload);
            }
          });
        } catch (e) {
          console.error(`[DEVICE SIM ${this.mac}] Error parsing incoming MQTT command:`, e);
        }
      });

      this.client.on('error', (err) => {
        console.error(`[DEVICE SIM ${this.mac}] MQTT error:`, err);
      });
    });
  }

  pushTelemetry(metrics) {
    if (!this.client || !this.client.connected || this.offlineMode) {
      console.warn(`[DEVICE SIM ${this.mac}] Cannot push telemetry: Client offline`);
      return;
    }
    const topic = `smarthome/${this.mac}/telemetry`;
    const payload = {
      device_id: this.mac,
      timestamp: new Date().toISOString(),
      seq: this.seq++,
      metrics: metrics,
      rssi: -60,
      battery: 100
    };
    this.client.publish(topic, JSON.stringify(payload), { qos: 1 });
    console.log(`[DEVICE SIM ${this.mac}] Pushed telemetry to ${topic}:`, payload);
  }

  stop() {
    return new Promise((resolve) => {
      if (this.client) {
        this.client.end(true, () => {
          console.log(`[DEVICE SIM ${this.mac}] Disconnected from MQTT Broker`);
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

module.exports = DeviceSimulator;
