# tiiiscord

A standalone Discord bridge for T3 Code. Post in a configured channel to start a Discord thread and a matching T3 thread. Replies continue the same conversation, and you can pick it up in T3 at any time. No T3 server changes are required.

## Setup

Requires Node.js 24+, a T3 server with orchestration protocol V2, and a Discord bot with **Message Content Intent** enabled. Invite the bot with permission to view/send messages, read message history, create public threads, send messages in threads, and attach files.

```sh
npm ci
npm run setup
npm run doctor
npm start
```

Setup connects your bot and T3 environment, maps a Discord channel to a T3 project, and selects the Discord users allowed to control it. Credentials and state are saved in the gitignored `.local/` directory. Re-run setup when a T3 session expires.

Optionally copy `.env.example` to `.env` and fill in the values you need. The setup, start, doctor, and smoke scripts load `.env` using Node's native `--env-file-if-exists=.env`; no dotenv package is needed. Variables already set in your shell take precedence over `.env`.

Nonempty `DISCORD_TOKEN` and `T3_TOKEN` values override saved credentials. Leave either token blank or omit it to use the credentials saved by setup. `DISCORD_CHANNEL_ID` only supplies the default for the channel prompt during setup; runtime routes come from the saved configuration. Keep secrets and environment-specific IDs in `.env` or `.local/`, both ignored by git.

## Usage

- Post a task in the configured channel to create a thread.
- Reply in that thread to continue. Follow-ups steer an active run; idle threads start a new run.
- Use approval buttons or `!approve` / `!deny` for pending approvals.
- Answer agent questions with `!answer your answer`.
- Send `!stop` to stop the agent. Resume held work in T3.

The bridge uses **Auto** mode by default and tells the agent that Discord is its primary reply surface. Attachments are mirrored, HTML visuals are uploaded as files, and local paths are displayed as inline code. Normal web links remain clickable.

Thread mappings and accepted messages survive restarts. Messages sent while the bot is offline are not backfilled. Use a dedicated T3 project when concurrent threads should share their own workspace.

## Development

```sh
npm test
npm run typecheck
```

Run `npm run doctor` after a T3 update to check connectivity and channel permissions. The bridge uses T3's internal V2 socket API.

## License

[MIT](LICENSE).
