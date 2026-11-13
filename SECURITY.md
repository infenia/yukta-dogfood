# Security policy

Report vulnerabilities privately through GitHub's "Report a vulnerability" (Security tab), not in a public issue.

`yukta-dogfood` is developer tooling: it starts a local Yukta server, runs headless Claude sessions that edit a checkout, and holds a
read-only `fixer` key for that server. It is not meant to run on shared or production hosts.
