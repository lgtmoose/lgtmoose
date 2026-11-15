# @lgtmoose/evals

Runs the review pipeline (the one behind `lgtmoose review --dry-run`) on fixtures and scores what it would post: recall, false-positive rate, severity accuracy, cost and time.

It also runs the learning-speed scenarios in `learning/`: whether a correction (`learn:`, a decline and `remember`, repeated rejections, an approved bootstrap learning) sticks on the next review, and that none quiets a protected-category finding.

The guide is [docs/evals.md](../../docs/evals.md): the fixture format, scores, running it, the learning-speed scenarios, the provider matrix, private fixtures and CI. The fixtures themselves are listed in [fixtures/README.md](fixtures/README.md).
