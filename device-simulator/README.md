# Device Simulator

The simulator creates real API accounts, factory-provisions virtual devices,
claims them through API Gateway, connects each runtime to MQTT and emits the
same Product V2 telemetry/presence/ACK contracts as firmware.

Virtual devices follow backend Hub–Node assignments. Nodes relay through the
active virtual Hub, switch to direct MQTT fallback when its lease disappears,
and return to relay after a valid topology update. Operation inputs are checked
again against the published catalog before state mutation.

Protected camera operations return a short-lived simulated resource locator.
Each virtual device also has its own RSA key pair: the public key is provisioned
in PostgreSQL, while the private key is encrypted in the simulator registry.
Credential envelopes are decrypted only inside that virtual device; the
registry stores only a verifier digest, never plaintext PIN material.

Start the full stack from the repository root:

```powershell
docker compose up --build
```

Open `http://localhost:4000`. Configure the number of users, the min/max device
count, Product distribution and network count, then create a run. Generated
accounts and their initial passwords are shown in the simulator dashboard.
Automatic runs expire after 24 hours; manually retained runs remain until
explicit cleanup. Persistent PostgreSQL and MongoDB data live under
`E:\smarthome_data` as configured by the root Compose file.
