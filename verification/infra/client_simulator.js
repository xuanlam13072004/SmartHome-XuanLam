const axios = require('axios');
const WebSocket = require('ws');

class ClientSimulator {
  constructor(apiUrl = 'http://localhost:3000', wsUrl = 'ws://localhost:3001/ws') {
    this.apiUrl = apiUrl;
    this.wsUrl = wsUrl;
    this.token = null;
    this.ws = null;
    this.receivedEvents = [];
    this.userId = null;
  }

  async register(username, email, password, fullName = 'Verification User') {
    try {
      const response = await axios.post(`${this.apiUrl}/auth/register`, {
        username,
        email,
        password,
        full_name: fullName
      });
      console.log(`[CLIENT SIM] Registered user: ${email}`);
      return response.data;
    } catch (e) {
      console.error(`[CLIENT SIM] Register failed:`, e.response?.data || e.message);
      throw e;
    }
  }

  async login(email, password) {
    try {
      const response = await axios.post(`${this.apiUrl}/auth/login`, {
        email,
        password
      });
      this.token = response.data.access_token;
      console.log(`[CLIENT SIM] Logged in successfully. Token obtained.`);
      return response.data;
    } catch (e) {
      console.error(`[CLIENT SIM] Login failed:`, e.response?.data || e.message);
      throw e;
    }
  }

  async getMe() {
    try {
      const response = await axios.get(`${this.apiUrl}/auth/me`, {
        headers: { Authorization: `Bearer ${this.token}` }
      });
      this.userId = response.data.user.id;
      return response.data;
    } catch (e) {
      console.error(`[CLIENT SIM] getMe failed:`, e.response?.data || e.message);
      throw e;
    }
  }

  async claimDevice(mac, secretKey, name) {
    try {
      const response = await axios.post(`${this.apiUrl}/devices/claim`, {
        mac,
        secret_key: secretKey,
        name
      }, {
        headers: { Authorization: `Bearer ${this.token}` }
      });
      console.log(`[CLIENT SIM] Claimed device ${mac}:`, response.data);
      return response.data;
    } catch (e) {
      console.error(`[CLIENT SIM] Claim failed for ${mac}:`, e.response?.data || e.message);
      throw e;
    }
  }

  async sendCommand(mac, action, instance, payload = {}) {
    try {
      const response = await axios.post(`${this.apiUrl}/devices/${mac}/commands`, {
        action,
        instance,
        payload
      }, {
        headers: { Authorization: `Bearer ${this.token}` }
      });
      console.log(`[CLIENT SIM] Sent command to ${mac}:`, response.data);
      return response.data;
    } catch (e) {
      console.error(`[CLIENT SIM] Send command failed:`, e.response?.data || e.message);
      throw e;
    }
  }

  async getDeviceState(mac) {
    try {
      const response = await axios.get(`${this.apiUrl}/devices/${mac}/state`, {
        headers: { Authorization: `Bearer ${this.token}` }
      });
      return response.data;
    } catch (e) {
      console.error(`[CLIENT SIM] Get state failed for ${mac}:`, e.response?.data || e.message);
      throw e;
    }
  }

  connectWS() {
    return new Promise((resolve, reject) => {
      if (!this.token) {
        return reject(new Error('Token missing. Log in first.'));
      }

      this.ws = new WebSocket(this.wsUrl, {
        headers: { Authorization: `Bearer ${this.token}` }
      });

      this.ws.on('open', () => {
        console.log(`[CLIENT SIM] WS connection opened`);
        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          const event = JSON.parse(data.toString());
          console.log(`[CLIENT SIM] WS Event received:`, event);
          this.receivedEvents.push(event);
        } catch (e) {
          console.error(`[CLIENT SIM] Error parsing WS message:`, e);
        }
      });

      this.ws.on('error', (err) => {
        console.error(`[CLIENT SIM] WS error:`, err);
        reject(err);
      });

      this.ws.on('close', (code, reason) => {
        console.log(`[CLIENT SIM] WS connection closed. Code: ${code}, Reason: ${reason}`);
      });
    });
  }

  disconnectWS() {
    if (this.ws) {
      this.ws.terminate();
      this.ws = null;
      console.log(`[CLIENT SIM] WS connection terminated`);
    }
  }
}

module.exports = ClientSimulator;
