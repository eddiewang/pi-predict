# Security

Report a vulnerability privately through GitHub: on the **Security** tab of
this repository, click **Report a vulnerability**. Do not open a public issue
for it.

pi-predict sends model requests to the provider of the Pi session, and it
reads the session files in the Pi agent directory. Reports about these
behaviors are in scope, for example:

- a prediction request that goes to a provider other than the session's;
- a request that the prefix guard should have stopped;
- a file outside `<agentDir>/sessions` that pi-predict reads;
- a file that pi-predict writes outside `<agentDir>/pi-predict/` and
  `<agentDir>/pi-predict.json` (with its temporary copy during a write).
