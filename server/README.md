# BOM Designer AI (instruction rephrasing)

`rephrase_proxy.py` gives the app's **✨ Improve with AI** button three rewrites of a step's
instruction (Corrected, Clearer, Shorter), naming the part added and the part it goes onto, using Google Gemini (`gemini-3.5-flash-lite`, free
tier). It keeps the Gemini API key on the server; the app only knows the proxy's address
(`src/ai.js`). Python standard library only.

## Where it runs

The Lesson Foundry EC2 server (eu-north-1, 51.21.180.129), next to Lesson Foundry, which it
does not touch.

| What | Where |
| --- | --- |
| Proxy | `/opt/build-steps-ai/rephrase_proxy.py`, systemd service `build-steps-ai` on 127.0.0.1:8787 |
| API key | `/etc/build-steps-ai.env` (`GEMINI_API_KEY=...`, root only, mode 600) |
| HTTPS | Caddy (`/etc/caddy/Caddyfile`), `https://51-21-180-129.sslip.io` with an automatic Let's Encrypt certificate |
| Firewall | The instance's AWS security group must allow inbound TCP 80 and 443 |

## Change the key

```
ssh -t -i ~/.ssh/ec2-thinkpro ubuntu@51.21.180.129 'read -rsp "Paste Gemini API key: " K; echo; printf "GEMINI_API_KEY=%s\n" "$K" | sudo tee /etc/build-steps-ai.env >/dev/null; sudo chmod 600 /etc/build-steps-ai.env; sudo systemctl restart build-steps-ai; echo Saved.'
```

## Update the proxy

```
scp -i ~/.ssh/ec2-thinkpro server/rephrase_proxy.py ubuntu@51.21.180.129:/tmp/
ssh -i ~/.ssh/ec2-thinkpro ubuntu@51.21.180.129 'sudo install -m 644 /tmp/rephrase_proxy.py /opt/build-steps-ai/ && sudo systemctl restart build-steps-ai'
```

## Check it

```
curl https://51-21-180-129.sslip.io/health
ssh -i ~/.ssh/ec2-thinkpro ubuntu@51.21.180.129 'sudo journalctl -u build-steps-ai -n 50'
```

Requests are logged without their text. Limits: 120 requests per phone per hour and 1,000 per
day in total (settings at the top of the proxy), on top of Gemini's own free-tier limits.
