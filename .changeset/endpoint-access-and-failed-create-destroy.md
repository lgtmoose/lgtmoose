---
"lgtmoose": patch
---

Control Lambdas, the egress proxy and the dashboard API can reach the Secrets Manager, ECR and Logs VPC endpoints, so the database migrations no longer time out on the first deploy. `destroy` also turns off deletion protection when an earlier deploy failed to create the Data stack and left it without outputs.
