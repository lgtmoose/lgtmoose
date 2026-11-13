# jobs

Runs background jobs from the queue.

## Running

    npm start

## Retries

A failed job is tried 5 times in all. The wait before each retry starts at 1 second and doubles,
up to 60 seconds. The settings are in `src/retry.ts`.
