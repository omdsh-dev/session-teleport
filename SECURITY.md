# Security policy

## Reporting a vulnerability

Use GitHub private vulnerability reporting when it is enabled for the
repository. Do not place credentials, session export bundles, production event
data, database dumps, or exploit details in a public issue. If private
reporting is unavailable, open a public issue containing no sensitive details
to request a private coordination channel.

For non-sensitive defects, open a normal issue with the smallest reproducible
example. Replace hostnames, account names, tokens, Session content and database
connection details with explicit placeholders before attaching logs.

## Supported versions

Security fixes target the latest supported revision on `main`. Deployments
installed from Git should use an exact reviewed commit SHA so an update is
deliberate and reproducible.

## Security boundary

This repository distributes the Session Teleport plugin only. Its DSH peer
packages and PostgreSQL deployment are external dependencies with their own
update, access-control and vulnerability-management processes.
