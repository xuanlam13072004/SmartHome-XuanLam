const net = require('net');

const port = 1883;
let server = null;
let activeConnections = [];

function readLength(buffer, start) {
  let multiplier = 1;
  let value = 0;
  let index = start;
  let encodedByte;
  do {
    if (index >= buffer.length) throw new Error('Incomplete remaining length');
    encodedByte = buffer[index++];
    value += (encodedByte & 127) * multiplier;
    multiplier *= 128;
    if (multiplier > 128 * 128 * 128) {
      throw new Error('Malformed Remaining Length');
    }
  } while ((encodedByte & 128) !== 0);
  return { value, bytes: index - start };
}

function matchesTopic(subscribed, published) {
  const regexStr = '^' + subscribed
    .replace(/\//g, '\\/')
    .replace(/\+/g, '[^\\/]+')
    .replace(/#/g, '.*') + '$';
  return new RegExp(regexStr).test(published);
}

class MqttConnection {
  constructor(socket) {
    this.socket = socket;
    this.subscriptions = [];
    this.buffer = Buffer.alloc(0);

    socket.on('data', (data) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      this.processBuffer();
    });

    socket.on('close', () => {
      activeConnections = activeConnections.filter(c => c !== this);
    });

    socket.on('error', () => {});
  }

  processBuffer() {
    while (this.buffer.length >= 2) {
      let lengthInfo;
      try {
        lengthInfo = readLength(this.buffer, 1);
      } catch (e) {
        break; // Wait for more data
      }
      
      const headerLength = 1 + lengthInfo.bytes;
      const packetLength = headerLength + lengthInfo.value;
      
      if (this.buffer.length < packetLength) {
        break; // Incomplete packet
      }
      
      const type = this.buffer[0] >> 4;
      const flags = this.buffer[0] & 0x0f;
      const packet = this.buffer.subarray(headerLength, packetLength);
      
      this.handlePacket(type, flags, packet);
      this.buffer = this.buffer.subarray(packetLength);
    }
  }

  handlePacket(type, flags, packet) {
    if (type === 1) { // CONNECT
      this.socket.write(Buffer.from([0x20, 0x02, 0x00, 0x00])); // CONNACK
    } else if (type === 8) { // SUBSCRIBE
      const msgIdHi = packet[0];
      const msgIdLo = packet[1];
      
      let index = 2;
      while (index < packet.length) {
        const topicLen = (packet[index] << 8) | packet[index + 1];
        const topic = packet.toString('utf8', index + 2, index + 2 + topicLen);
        console.log('[BROKER] Client subscribed to:', topic);
        this.subscriptions.push(topic);
        index += 2 + topicLen + 1; // topic length + topic bytes + requested QoS (1 byte)
      }
      
      this.socket.write(Buffer.from([0x90, 0x03, msgIdHi, msgIdLo, 0x01])); // SUBACK
    } else if (type === 3) { // PUBLISH
      const topicLen = (packet[0] << 8) | packet[1];
      const topic = packet.toString('utf8', 2, 2 + topicLen);
      
      let payloadIndex = 2 + topicLen;
      const qos = (flags >> 1) & 0x03;
      let msgIdHi = 0, msgIdLo = 0;
      if (qos > 0) {
        msgIdHi = packet[payloadIndex];
        msgIdLo = packet[payloadIndex + 1];
        payloadIndex += 2;
      }
      
      const payload = packet.subarray(payloadIndex);
      console.log('[BROKER] Client published to:', topic, 'payload:', payload.toString());

      // Reply with PUBACK if QoS 1
      if (qos === 1) {
        this.socket.write(Buffer.from([0x40, 0x02, msgIdHi, msgIdLo]));
      }

      // Forward to matching subscribers
      console.log('[BROKER] activeConnections count:', activeConnections.length);
      for (const conn of activeConnections) {
        if (conn === this) continue;
        console.log('[BROKER] Connection subscriptions:', conn.subscriptions);
        for (const sub of conn.subscriptions) {
          const match = matchesTopic(sub, topic);
          console.log('[BROKER] Compare sub:', sub, 'vs topic:', topic, '-> match:', match);
          if (match) {
            console.log('[BROKER] Forwarding packet to connection...');
            conn.sendPublish(topic, payload, qos);
            break;
          }
        }
      }
    } else if (type === 12) { // PINGREQ
      this.socket.write(Buffer.from([0xd0, 0x00])); // PINGRESP
    } else if (type === 14) { // DISCONNECT
      this.socket.destroy();
    }
  }

  sendPublish(topic, payload, qos) {
    const topicBuffer = Buffer.from(topic, 'utf8');
    const variableHeader = Buffer.alloc(2 + topicBuffer.length + (qos > 0 ? 2 : 0));
    variableHeader.writeUInt16BE(topicBuffer.length, 0);
    topicBuffer.copy(variableHeader, 2);
    
    if (qos > 0) {
      variableHeader.writeUInt16BE(1, 2 + topicBuffer.length); // Dummy msg ID
    }

    const remainingLength = variableHeader.length + payload.length;
    
    // Remaining length encoding
    const lengthBytes = [];
    let num = remainingLength;
    do {
      let d = num % 128;
      num = Math.floor(num / 128);
      if (num > 0) d |= 128;
      lengthBytes.push(d);
    } while (num > 0);

    const fixedHeader = Buffer.from([0x30 | (qos << 1), ...lengthBytes]);
    const packet = Buffer.concat([fixedHeader, variableHeader, payload]);
    this.socket.write(packet);
  }
}

function startBroker() {
  return new Promise((resolve) => {
    server = net.createServer((socket) => {
      const conn = new MqttConnection(socket);
      activeConnections.push(conn);
    });

    server.listen(port, '0.0.0.0', () => {
      console.log(`[INFRA] Mock MQTT Broker started on port ${port}`);
      resolve();
    });
  });
}

function stopBroker() {
  return new Promise((resolve) => {
    if (server) {
      server.close(() => {
        console.log('[INFRA] Mock MQTT Broker stopped');
        resolve();
      });
      activeConnections.forEach(c => c.socket.destroy());
      activeConnections = [];
    } else {
      resolve();
    }
  });
}

if (require.main === module) {
  startBroker();
}

module.exports = { startBroker, stopBroker };
