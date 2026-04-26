#!/usr/bin/env node
import { loadConfig, validateConfig } from "../src/config.js";
import { SlackClient } from "../src/slack.js";

const config = loadConfig();
validateConfig(config);

const slack = new SlackClient({
  botToken: config.slackBotToken,
  appToken: config.slackAppToken
});

const auth = await slack.authTest();
const socket = await slack.openSocketUrl();

console.log(JSON.stringify({
  ok: true,
  botUserId: auth.user_id,
  teamId: auth.team_id,
  socketMode: Boolean(socket)
}, null, 2));
