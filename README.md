# cata-centavo

## Cache and logging

With `CATA_CENTAVO_LOG_LEVEL=debug`, the log file contains financial data.

## Categories, and one asymmetry worth knowing about

Categories come from your provider while your plan includes transaction enrichment. Every sync copies them into `data.db`, which is never dropped, so they survive the day the enrichment stops and the day the cache is rebuilt.

Alongside that, the server learns which categories go with which CNPJs from your own transactions — but only from a CNPJ, never from a CPF, and only when that merchant's transactions actually agree. A CNPJ has a line of business. A CPF is a person, and guessing that everything you send your sister is a "transfer" would then be applied backwards over everything you ever sent her.

That learned map is built from your data, on your machine, and is not shipped with the tool — a CNPJ-to-category table is a line of somebody's bank statement. **So there is a real asymmetry: if you install this after your own enrichment has already stopped, the map starts empty and has nothing to learn from.** You still get merchant-code categorization on card purchases, plus whatever you correct by hand, and corrections apply retroactively. But you will be doing more of the work than someone who installed earlier.

Ask the agent to show you what is uncategorized and tell it what those merchants are; both kinds of correction stick.
