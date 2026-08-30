# Security policy

## Supported versions

Only the latest `main` branch receives security fixes. Releases are tagged from
`main`; see the [releases page](https://github.com/gregnazario/hedgehog-pr-bot/releases).

## Reporting a vulnerability

Please use
[GitHub private vulnerability reporting](https://github.com/gregnazario/hedgehog-pr-bot/security/advisories/new)
instead of opening a public issue. Include reproduction steps and, for webhook or
model-prompting issues, the relevant headers or prompt text with secrets redacted.

## Handling credentials

If an App private key, webhook secret, or model API key is exposed, rotate it
immediately: regenerate the key in GitHub App settings, change the webhook secret,
and revoke the provider key. The bot keeps credentials only in its environment and
removes them from the model subprocess environment, but a leaked secret must still
be treated as compromised.
