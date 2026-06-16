/**
 * config-env-bootstrap.js — hydrate process.env from the unified YAML at startup.
 *
 * This bridges piece 5 of the unified-config refactor. Rather than rewriting
 * 855 process.env.* references across the codebase, we flip the script: YAML
 * is read first, then any value that maps to a known env var is written into
 * process.env BEFORE the rest of the bot's modules are imported.
 *
 * Hydration policy:
 *   - YAML values overlay process.env: if a YAML key is set, it WINS over .env.
 *   - This matches the "config.yaml is Lance's edit surface" intent.
 *   - Set OPENJARVIS_CONFIG_ENV_HYDRATE=skip to disable (emergency override).
 *
 * Must be imported AFTER `dotenv/config` (so .env is loaded first as the
 * baseline) and BEFORE any module that reads process.env at top level.
 */

import config from './config.js';

const YAML_TO_ENV = [
  // discord.*
  ['discord.token',             'DISCORD_TOKEN'],
  ['discord.guildId',           'DISCORD_GUILD_ID'],
  ['discord.voiceChannelId',    'DISCORD_VOICE_CHANNEL_ID'],
  ['discord.textChannelId',     'DISCORD_TEXT_CHANNEL_ID'],
  ['discord.ccChannelId',       'DISCORD_CC_CHANNEL_ID'],
  ['discord.activityChannelId', 'DISCORD_ACTIVITY_CHANNEL_ID'],
  ['discord.circuitBreakerChannelId', 'DISCORD_CIRCUIT_BREAKER_CHANNEL'],
  ['discord.hudChannelId',      'HUD_CHANNEL_ID'],
  ['discord.voiceReportChannelId',    'VOICE_REPORT_CHANNEL_ID'],
  ['discord.voiceTranscriptChannelId','VOICE_TRANSCRIPT_CHANNEL_ID'],
  ['discord.voiceCallbackChannelId',  'VOICE_CALLBACK_CHANNEL_ID'],
  ['discord.recordChannelId',         'RECORD_CHANNEL_ID'],
  ['discord.recordTextChannelId',     'RECORD_TEXT_CHANNEL_ID'],
  ['discord.botId',             'JARVIS_BOT_ID'],
  ['discord.ownerUserId',       'OWNER_USER_ID'],

  // telegram.*
  ['telegram.token',        'TELEGRAM_BOT_TOKEN'],
  ['telegram.owner',        'TELEGRAM_OWNER_ID'],
  ['telegram.allowedUsers', 'TELEGRAM_ALLOWED_USERS'],

  // gateway.*
  ['gateway.url',               'JARVIS_GATEWAY_URL'],
  ['gateway.token',             'JARVIS_GATEWAY_TOKEN'],
  ['gateway.timeoutMs',         'GATEWAY_TIMEOUT_MS'],
  ['gateway.firstTokenTimeoutMs','GATEWAY_FIRST_TOKEN_TIMEOUT_MS'],
  ['gateway.interimEnabled',    'GATEWAY_INTERIM_ENABLED'],

  // admin.*
  ['admin.token',               'JARVIS_ADMIN_TOKEN'],
  ['admin.port',                'JARVIS_ADMIN_PORT'],
  ['admin.bind',                'JARVIS_ADMIN_BIND'],
  ['admin.userIds',             'JARVIS_ADMIN_USER_IDS'],
  ['admin.allowedUsers',        'ALLOWED_USERS'],
  ['admin.userNames',           'JARVIS_USER_NAMES'],
  ['admin.sessionUser',         'SESSION_USER'],

  // clawd.*
  ['clawd.botId',               'CLAWDBOT_BOT_ID'],
  ['clawd.gatewayToken',        'CLAWDBOT_GATEWAY_TOKEN'],
  ['clawd.gatewayUrl',          'CLAWDBOT_GATEWAY_URL'],

  // flags.*
  ['flags.speakerVerifyEnabled',     'SPEAKER_VERIFY_ENABLED'],
  ['flags.speakerVerifyStrict',      'SPEAKER_VERIFY_STRICT'],
  ['flags.taskAgentEnabled',         'TASK_AGENT_ENABLED'],
  ['flags.multiUserEnabled',         'MULTI_USER_ENABLED'],
  ['flags.activityFeedEnabled',      'ACTIVITY_FEED_ENABLED'],
  ['flags.voiceMessageAutoReply',    'VOICE_MESSAGE_AUTO_REPLY'],
  ['flags.webhookCallbackMode',      'WEBHOOK_CALLBACK_MODE'],
  ['flags.voiceAckEnabled',          'VOICE_ACK_ENABLED'],
  ['flags.agentDispatchAckEnabled',  'AGENT_DISPATCH_ACK_ENABLED'],
  ['flags.immediateAcksEnabled',     'IMMEDIATE_ACKS_ENABLED'],
  ['flags.voiceThreadReportsEnabled','VOICE_THREAD_REPORTS'],
  ['flags.hudEnabled',               'HUD_ENABLED'],
  ['flags.hudTrelloEnabled',         'HUD_TRELLO'],
  ['flags.sttEnabled',               'JARVIS_STT_ENABLED'],
  ['flags.ttsKokoroEnabled',         'JARVIS_TTS_KOKORO_ENABLED'],
  ['flags.ttsChatterboxEnabled',     'JARVIS_TTS_CHATTERBOX_ENABLED'],
  ['flags.piperEnabled',             'PIPER_ENABLED'],
  ['flags.sttStreamingEnabled',      'STT_STREAMING_ENABLED'],
  ['flags.streamingTtsEnabled',      'STREAMING_TTS_ENABLED'],
  ['flags.muteQueueEnabled',         'MUTE_QUEUE_ENABLED'],
  ['flags.muteQueueWakeBypass',      'MUTE_QUEUE_WAKE_BYPASS'],
  ['flags.unmuteImplicitWake',       'UNMUTE_IMPLICIT_WAKE'],
  ['flags.wakeWordEnabled',          'VOICE_WAKE_WORD_ENABLED'],
  ['flags.wakeWordAuto',             'WAKE_WORD_AUTO'],
  ['flags.wakeWordFuzzy',            'WAKE_WORD_FUZZY'],
  ['flags.wakeWordFuzzyRequireSpeaker','WAKE_WORD_FUZZY_REQUIRE_SPEAKER'],
  ['flags.speakerRebuffEnabled',     'SPEAKER_REBUFF_ENABLED'],
  ['flags.joinBriefingEnabled',      'JOIN_BRIEFING_ENABLED'],
  ['flags.joinBriefingMacOpen',      'JOIN_BRIEFING_MAC_OPEN'],
  ['flags.joinBriefingTrelloEnabled','JOIN_BRIEFING_TRELLO'],
  ['flags.haikuAmbientClassifierEnabled','HAIKU_AMBIENT_CLASSIFIER_ENABLED'],
  ['flags.haikuAmbientLogDecisions', 'HAIKU_AMBIENT_LOG_DECISIONS'],
  ['flags.discordMemoryEnabled',     'DISCORD_MEMORY_ENABLED'],
  ['flags.discordMemoryIgnoreOtherBots','DISCORD_MEMORY_IGNORE_OTHER_BOTS'],
  ['flags.voiceMemoryEnabled',       'VOICE_MEMORY_ENABLED'],
  ['flags.obsidianEnabled',          'OBSIDIAN_ENABLED'],
  ['flags.alertsAlsoPostText',       'ALERTS_ALSO_POST_TEXT'],
  ['flags.voiceStreaming',           'VOICE_STREAMING'],
  ['flags.voiceDefaultThinking',     'VOICE_DEFAULT_THINKING'],
  ['flags.sessionShellEnabled',      'SESSION_SHELL_ENABLED'],
  ['flags.devMode',                  'DEV_MODE'],
  ['flags.onScreen',                 'ON_SCREEN'],
  ['flags.boxes',                    'BOXES'],

  // models.*
  ['models.voice',              'VOICE_MODEL'],
  ['models.default',            'DEFAULT_MODEL'],
  ['models.dispatch',           'DISPATCH_MODEL'],
  ['models.dispatchDeep',       'DISPATCH_MODEL_DEEP'],
  ['models.text',               'TEXT_MODEL'],
  ['models.haikuIntent',        'HAIKU_INTENT_MODEL'],
  ['models.haikuAmbient',       'HAIKU_AMBIENT_MODEL'],

  // voice.*
  ['voice.name',                'VOICE_NAME'],
  ['voice.persona',             'VOICE_PERSONA'],
  ['voice.wakeWord',            'VOICE_WAKE_WORD'],
  ['voice.pauseThresholdMs',    'VOICE_PAUSE_THRESHOLD_MS'],
  ['voice.longPauseMs',         'VOICE_LONG_PAUSE_MS'],
  ['voice.threadTtlMs',         'VOICE_THREAD_TTL_MS'],
  ['voice.messageChannels',     'VOICE_MESSAGE_CHANNELS'],
  ['voice.conversationWindowMs','CONVERSATION_WINDOW_MS'],
  ['voice.extendedConversationWindowMs','EXTENDED_CONVERSATION_WINDOW_MS'],
  ['voice.conversationHistoryMax','CONVERSATION_HISTORY_MAX'],
  ['voice.conversationHistoryMaxChars','CONVERSATION_HISTORY_MAX_CHARS'],
  ['voice.postSpeakAttentionMs','POST_SPEAK_ATTENTION_MS'],
  ['voice.speakingHoldMs',      'SPEAKING_HOLD_MS'],
  ['voice.staleInlineMs',       'STALE_INLINE_MS'],
  ['voice.transcriptDedupMs',   'TRANSCRIPT_DEDUP_MS'],
  ['voice.semanticDedupThreshold','SEMANTIC_DEDUP_THRESHOLD'],
  ['voice.inflightSimilarityThreshold','INFLIGHT_SIMILARITY_THRESHOLD'],
  ['voice.maxSpokenSeconds',    'MAX_SPOKEN_SECONDS'],
  ['voice.utteranceDebounceMs', 'UTTERANCE_DEBOUNCE_MS'],
  ['voice.vadTimeoutMs',        'VAD_TIMEOUT'],
  ['voice.btLeadInMs',          'BT_LEAD_IN_MS'],
  ['voice.stopPrefixesExtra',   'STOP_PREFIXES_EXTRA'],
  ['voice.stopWordsExtra',      'STOP_WORDS_EXTRA'],

  // wake.*
  ['wake.phrases',              'WAKE_WORD_PHRASES'],
  ['wake.fuzzyMaxPrefix',       'WAKE_WORD_FUZZY_MAX_PREFIX'],
  ['wake.fuzzyMinSentence',     'WAKE_WORD_FUZZY_MIN_SENTENCE'],
  ['wake.fuzzyMinWords',        'WAKE_WORD_FUZZY_MIN_WORDS'],
  ['wake.sleepWords',           'SLEEP_WORDS'],
  ['wake.sleepWakeWords',       'SLEEP_WAKE_WORDS'],

  // stt.*
  ['stt.provider',              'STT_PROVIDER'],
  ['stt.url',                   'STT_URL'],
  ['stt.streamingUrl',          'STT_STREAMING_URL'],
  ['stt.whisperUrl',            'WHISPER_URL'],
  ['stt.whisperPath',           'WHISPER_PATH'],
  ['stt.whisperModel',          'WHISPER_MODEL'],
  ['stt.fasterWhisperUrl',      'FASTER_WHISPER_URL'],
  ['stt.mlxWhisperUrl',         'MLX_WHISPER_URL'],
  ['stt.deepgramApiKey',        'DEEPGRAM_API_KEY'],
  ['stt.voskPython',            'VOSK_PYTHON'],
  ['stt.minAudioDurationMs',    'MIN_AUDIO_DURATION_MS'],
  ['stt.minAudioRms',           'MIN_AUDIO_RMS'],
  ['stt.noSpeechProbThreshold', 'NO_SPEECH_PROB_THRESHOLD'],
  ['stt.confidenceThreshold',   'CONFIDENCE_THRESHOLD'],
  ['stt.borderlineConfidence',  'BORDERLINE_CONFIDENCE'],
  ['stt.systemdUnit',           'JARVIS_STT_SYSTEMD_UNIT'],

  // tts.*
  ['tts.provider',              'TTS_PROVIDER'],
  ['tts.batchMaxChars',         'TTS_BATCH_MAX_CHARS'],
  ['tts.batchMinChars',         'TTS_BATCH_MIN_CHARS'],
  ['tts.pipelineConcurrency',   'TTS_PIPELINE_CONCURRENCY'],
  ['tts.queueMax',              'TTS_QUEUE_MAX'],
  ['tts.audioQueueMaxSize',     'AUDIO_QUEUE_MAX_SIZE'],
  ['tts.chatterboxUrl',         'CHATTERBOX_URL'],
  ['tts.chatterboxVoice',       'CHATTERBOX_VOICE'],
  ['tts.kokoroUrl',             'KOKORO_URL'],
  ['tts.kokoroVoice',           'KOKORO_VOICE'],
  ['tts.edgeTtsPath',           'EDGE_TTS_PATH'],
  ['tts.edgeTtsVoice',          'EDGE_TTS_VOICE'],
  ['tts.qwen3Url',              'QWEN3_TTS_URL'],
  ['tts.qwen3Voice',            'QWEN3_TTS_VOICE'],
  ['tts.qwen3Lang',             'QWEN3_TTS_LANG'],
  ['tts.piperBin',              'PIPER_BIN'],
  ['tts.piperBind',             'PIPER_BIND'],
  ['tts.piperPort',             'PIPER_PORT'],
  ['tts.piperUrl',              'PIPER_URL'],
  ['tts.piperModel',            'PIPER_MODEL'],
  ['tts.kokoroSystemdUnit',     'JARVIS_TTS_KOKORO_SYSTEMD_UNIT'],
  ['tts.kokoroDockerName',      'JARVIS_TTS_KOKORO_DOCKER_NAME'],
  ['tts.chatterboxSystemdUnit', 'JARVIS_TTS_CHATTERBOX_SYSTEMD_UNIT'],

  // speaker.*
  ['speaker.verifyUrl',         'SPEAKER_VERIFY_URL'],
  ['speaker.diarizeUrl',        'SPEAKER_DIARIZE_URL'],
  ['speaker.threshold',         'SPEAKER_THRESHOLD'],
  ['speaker.passphrase',        'SPEAKER_PASSPHRASE'],
  ['speaker.rebuffCooldownMs',  'SPEAKER_REBUFF_COOLDOWN_MS'],

  // haiku.*
  ['haiku.ambientLogChannel',   'HAIKU_AMBIENT_LOG_CHANNEL'],
  ['haiku.ambientPhase',        'HAIKU_AMBIENT_PHASE'],
  ['haiku.ambientTimeoutMs',    'HAIKU_AMBIENT_TIMEOUT_MS'],
  ['haiku.ambientWindowMs',     'HAIKU_AMBIENT_WINDOW_MS'],
  ['haiku.intentTimeoutMs',     'HAIKU_INTENT_TIMEOUT_MS'],

  // discordMemory.*
  ['discordMemory.backfillLimit',         'DISCORD_MEMORY_BACKFILL_LIMIT'],
  ['discordMemory.channelAllowlist',      'DISCORD_MEMORY_CHANNEL_ALLOWLIST'],
  ['discordMemory.channelDenylist',       'DISCORD_MEMORY_CHANNEL_DENYLIST'],
  ['discordMemory.dbPath',                'DISCORD_MEMORY_DB_PATH'],
  ['discordMemory.inputTokenBudget',      'DISCORD_MEMORY_INPUT_TOKEN_BUDGET'],
  ['discordMemory.maxCharsPerMessage',    'DISCORD_MEMORY_MAX_CHARS_PER_MESSAGE'],

  // memory.*
  ['memory.voiceFile',          'VOICE_MEMORY_FILE'],
  ['memory.voiceRecallEntries', 'VOICE_MEMORY_RECALL'],
  ['memory.haivemindUrl',       'HAIVEMIND_URL'],
  ['memory.haivemindTimeoutMs', 'HAIVEMIND_TIMEOUT_MS'],
  ['memory.obsidianVault',      'OBSIDIAN_VAULT'],
  ['memory.sessionChatStore',   'SESSION_CHAT_STORE'],
  ['memory.sessionMax',         'SESSION_MAX'],
  ['memory.sessionTimeoutMs',   'SESSION_TIMEOUT_MS'],
  ['memory.sessionRotationIdleMs','SESSION_ROTATION_IDLE_MS'],
  ['memory.maxTurns',           'JARVIS_MAX_TURNS'],
  ['memory.maxAgeMs',           'JARVIS_MAX_AGE_MS'],

  // webhook.*
  ['webhook.host',              'ALERT_WEBHOOK_HOST'],
  ['webhook.port',              'ALERT_WEBHOOK_PORT'],
  ['webhook.token',             'ALERT_WEBHOOK_TOKEN'],

  // mute.*
  ['mute.queueMax',             'MUTE_QUEUE_MAX'],
  ['mute.queueTtlMs',           'MUTE_QUEUE_TTL_MS'],

  // hud.*
  ['hud.debounceMs',            'HUD_DEBOUNCE_MS'],

  // task.*
  ['task.autoSleepMs',          'TASK_AUTO_SLEEP_MS'],
  ['task.followupThresholdMs',  'TASK_FOLLOWUP_THRESHOLD_MS'],
  ['task.ledgerMax',            'TASK_LEDGER_MAX'],
  ['task.orphanGraceMs',        'TASK_ORPHAN_GRACE_MS'],
  ['task.orphanThresholdMs',    'TASK_ORPHAN_THRESHOLD_MS'],
  ['task.dispatchedOrphanMs',   'TASK_DISPATCHED_ORPHAN_MS'],
  ['task.workingOrphanMs',      'TASK_WORKING_ORPHAN_MS'],
  ['task.schedulerTickMs',      'SCHEDULER_TICK_MS'],

  // joinBriefing.*
  ['joinBriefing.calendar',     'JOIN_BRIEFING_CALENDAR'],
  ['joinBriefing.cooldownMs',   'JOIN_BRIEFING_COOLDOWN_MS'],
  ['joinBriefing.hours',        'JOIN_BRIEFING_HOURS'],

  // calendar.*
  ['calendar.googleEmail',      'GOOGLE_CALENDAR_EMAIL'],
  ['calendar.workspaceEmail',   'GOOGLE_WORKSPACE_EMAIL'],

  // kanban.*
  ['kanban.bin',                'KANBAN_BIN'],
  ['kanban.nodeBin',            'KANBAN_NODE_BIN'],
  ['kanban.worktreePathsFile',  'WORKTREE_PATHS_FILE'],

  // sonos.*
  ['sonos.bedroomIp',           'SONOS_BEDROOM_IP'],
  ['sonos.kitchenIp',           'SONOS_KITCHEN_IP'],
  ['sonos.httpPort',            'SONOS_HTTP_PORT'],
  ['sonos.ytdlpPath',           'YTDLP_PATH'],

  // trello.*
  ['trello.apiKey',             'TRELLO_API_KEY'],
  ['trello.token',              'TRELLO_TOKEN'],
  ['trello.boardId',            'TRELLO_BOARD_ID'],
  ['trello.commitsListId',      'TRELLO_COMMITS_LIST_ID'],
  ['trello.currentListId',      'TRELLO_CURRENT_LIST_ID'],

  // hosts.*
  ['hosts.macSshHost',          'MAC_SSH_HOST'],
  ['hosts.macSshKey',           'MAC_SSH_KEY'],
  ['hosts.macOpenTimeoutMs',    'MAC_OPEN_TIMEOUT_MS'],
  ['hosts.gamezSshHost',        'GAMEZ_SSH_HOST'],
  ['hosts.tailscaleIp',         'TAILSCALE_IP'],
  ['hosts.lanHost',             'JARVIS_LAN_HOST'],

  // paths.*
  ['paths.stateDir',            'JARVIS_STATE_DIR'],
  ['paths.channelRegistry',     'JARVIS_CHANNEL_REGISTRY'],
  ['paths.channelAccounts',     'CHANNEL_ACCOUNTS_PATH'],
  ['paths.channelContextsDir',  'CHANNEL_CONTEXTS_DIR'],
  ['paths.projectsJson',        'PROJECTS_JSON_PATH'],
  ['paths.mcpConfig',           'JARVIS_MCP_CONFIG_PATH'],
  ['paths.skillsDir',           'SKILLS_DIR'],
  ['paths.devRoot',             'DEV_ROOT'],
  ['paths.mcporter',            'MCPORTER_PATH'],
  ['paths.syncSkillsBin',       'JARVIS_SYNC_SKILLS_BIN'],

  // mcp.*
  ['mcp.timeoutMs',             'MCP_TIMEOUT_MS'],

  // logging.*
  ['logging.level',             'LOG_LEVEL'],

  // vault.*
  ['vault.opDefaultUsername',   'OP_DEFAULT_USERNAME'],
];

function _stringify(v) {
  if (v == null) return null;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.join(',');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function hydrateEnvFromConfig({ verbose = false } = {}) {
  if (process.env.OPENJARVIS_CONFIG_ENV_HYDRATE === 'skip') return { skipped: true, hydrated: 0 };
  let hydrated = 0;
  let overrode = 0;
  for (const [yamlPath, envKey] of YAML_TO_ENV) {
    const v = config.get(yamlPath);
    if (v === undefined || v === null || v === '') continue;
    const s = _stringify(v);
    if (s == null) continue;
    if (process.env[envKey] !== s) {
      if (process.env[envKey] !== undefined) overrode++;
      process.env[envKey] = s;
      hydrated++;
      if (verbose) console.error(`[config-env-bootstrap] ${envKey} <- ${yamlPath}`);
    }
  }
  return { hydrated, overrode };
}

if (process.env.OPENJARVIS_CONFIG_ENV_BOOTSTRAP_VERBOSE === 'true') {
  const r = hydrateEnvFromConfig({ verbose: true });
  console.error(`[config-env-bootstrap] hydrated=${r.hydrated} overrode=${r.overrode}`);
} else {
  hydrateEnvFromConfig();
}
