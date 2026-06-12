import { handleApi } from './api.js';
import { sendDailyReminders, sendWeeklySummary, sendMonthlyWinner } from './email.js';
import { todayInTZ } from './stats.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env);
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    // Crons are defined in wrangler.toml: daily reminder + Sunday summary.
    if (event.cron === '0 23 * * SUN') {
      ctx.waitUntil(sendWeeklySummary(env));
    } else {
      ctx.waitUntil(sendDailyReminders(env));
      if (todayInTZ(env.FAMILY_TZ).endsWith('-01')) {
        ctx.waitUntil(sendMonthlyWinner(env));
      }
    }
  },
};
