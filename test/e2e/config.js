export const config = {
  webhookToken: process.env.WEBHOOK_TOKEN || 'ad5913c79dd93ac4641f89225c5e49bd03730f2e85694f52',
  discordToken: process.env.DISCORD_TOKEN || '',
  hubChannelId: process.env.HUB_CHANNEL_ID || '1482037873426567229',
  host: '100.65.78.26',
  port: 3335,
};

export const baseURL = `http://${config.host}:${config.port}`;
