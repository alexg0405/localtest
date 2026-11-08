## Part 2: billed twice

A bug report from the utility's billing team:

> On Tuesday morning, operations re-ran Monday night's job after it timed
> out. Every customer was billed twice for Monday, and we've had to refund
> them by hand. Their usage pages looked normal. Re-runs happen a few times a
> month, so this can't happen again.

Find out why, and fix it: running the night again for the same day must
leave every bill as one run would. Other days' charges stay as they are.

`tests/test_part2_rerun.py` reproduces it.
