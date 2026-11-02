# Decisions

**What a line is:** a ruling a ledger marked `Ruling(binding):`, copied here by `omelette-fleet ledger sweep` once its plan's branch was deleted — ``- <path>:<line> · `<fragment>` · <date> · <plan> · <ruling>``, or the same without the pointer when it had none ([CONFIG](CONFIG.md#ledgers-and-the-decisions-register)).

**How a line dies:** `superseded by <what replaced it>` appended to it; it is never deleted in the release that strikes it.

