# Daily News

**Read it:** https://bemoredifferent.github.io/daily-news-overview/

One page a day with the stories the world's newsrooms are covering most, chosen without an editor and without a feed tuned to you.

## Why

Most news reaches us through a single outlet's editorial choices or through feeds that learn what we click and show us more of it. Either way, we end up seeing a narrow slice of the world, filtered by someone else's priorities or by our own habits.

Daily News takes the opposite approach. It reads headlines from more than 2,400 news sources across countries and languages and asks one question: which events are being reported most widely today? Those stories make the front page, and everyone sees the same front page.

## How a day's briefing is made

1. **Collect.** Every hour, headlines are gathered from 2,400+ news feeds worldwide.
2. **Group.** Once a day, the previous day's headlines are grouped by the event they describe, so 40 articles about the same story count as one story covered by 40 outlets.
3. **Rank.** Stories are ranked mainly by how many different outlets cover them. Sudden spikes in coverage, new developments and stories that keep running also count. No person picks or reorders them.
4. **Summarise.** An AI model writes a short headline and summary for each story, plus "The day in brief", using only the linked reporting.
5. **Compare.** Every story links to several original articles from different outlets, so you can read how each one tells it.

The result is the top 15 stories of the day, published every morning, with an archive of earlier days.

## What to keep in mind

- **Coverage is not importance.** A story ranks high because many outlets report it, which reflects what newsrooms find newsworthy, not what is objectively most important.
- **The source list shapes the result.** The sources span many countries and languages, but no list is perfectly balanced. Regions and languages with more feeds carry more weight.
- **AI summaries can be wrong.** They are written from the linked articles and marked as AI-generated. For anything that matters, follow the links to the original reporting.

## Privacy

There are no accounts and no personalisation. Optional, consent-based analytics count which stories are read so the briefing can be improved. When the site is installed as an app, its icon shows how many of the latest briefing's stories are still unread. Which stories have been read is stored only on the device. Details are in the [privacy policy](https://bemoredifferent.github.io/daily-news-overview/privacy.html).

## Running it yourself

The collector is a small Node.js service that runs on a single machine, and the website is a static page served from this repository (`index.html`, with one JSON file per day in `news/`).

```bash
npm install
npm start      # collect feeds hourly and publish the daily briefing
npm test       # run the tests
```

Technical details (architecture, configuration, the macOS background service and maintenance commands) are in [CLAUDE.md](CLAUDE.md).

## License

ISC
