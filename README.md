# seen

Tracks when users were last seen in chat channels.

## Commands

### seen <username>
Show when a user was last seen.

### since <minutes>
Show users seen in the last X minutes (max 1440 minutes).

### lurkers [days] [--limit N]
Show users who haven't been seen in X days.
- days: The number of days to look back (default 30, max 365)
- --limit N: Limit the number of results (default 10, max 50)

Examples:
- `lurkers` - Show top 10 lurkers from the last 30 days
- `lurkers 60` - Show top 10 lurkers from the last 60 days
- `lurkers 30 --limit 5` - Show top 5 lurkers from the last 30 days
- `lurkers --limit 20` - Show top 20 lurkers from the last 30 days