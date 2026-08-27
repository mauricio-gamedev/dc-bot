import {
  AutoModerationActionType,
  AutoModerationRuleEventType,
  AutoModerationRuleTriggerType,
} from 'discord.js';
import { STAFF_ROLE_NAMES } from './blueprint.js';

export const AUTOMOD_RULE_NAMES = [
  '🛡️ Miojo • Anti-spam',
  '🛡️ Miojo • Anti-raid de menções',
];

function alertActions(modLogChannel, customMessage, { timeoutSeconds = 0 } = {}) {
  const actions = [
    {
      type: AutoModerationActionType.BlockMessage,
      metadata: { customMessage },
    },
  ];

  if (modLogChannel) {
    actions.push({
      type: AutoModerationActionType.SendAlertMessage,
      metadata: { channel: modLogChannel.id },
    });
  }

  if (timeoutSeconds > 0) {
    actions.push({
      type: AutoModerationActionType.Timeout,
      metadata: { durationSeconds: timeoutSeconds },
    });
  }

  return actions;
}

export async function ensureAutoMod(guild, modLogChannel, report) {
  try {
    const rules = await guild.autoModerationRules.fetch();
    const exemptRoles = guild.roles.cache
      .filter((role) => STAFF_ROLE_NAMES.includes(role.name))
      .map((role) => role.id);

    const specs = [
      {
        name: AUTOMOD_RULE_NAMES[0],
        triggerType: AutoModerationRuleTriggerType.Spam,
        actions: alertActions(
          modLogChannel,
          'Mensagem bloqueada pelo anti-spam da comunidade.',
        ),
      },
      {
        name: AUTOMOD_RULE_NAMES[1],
        triggerType: AutoModerationRuleTriggerType.MentionSpam,
        triggerMetadata: {
          mentionTotalLimit: 4,
          mentionRaidProtectionEnabled: true,
        },
        actions: alertActions(
          modLogChannel,
          'Muitas menções de uma vez. A proteção anti-raid foi acionada.',
          { timeoutSeconds: 600 },
        ),
      },
    ];

    for (const spec of specs) {
      const existing = rules.find((rule) => rule.name === spec.name);
      if (!existing) {
        await guild.autoModerationRules.create({
          name: spec.name,
          enabled: true,
          eventType: AutoModerationRuleEventType.MessageSend,
          triggerType: spec.triggerType,
          triggerMetadata: spec.triggerMetadata,
          actions: spec.actions,
          exemptRoles,
          reason: 'MiojoPlays AutoMod baseline',
        });
        report.automodCreated.push(spec.name);
        continue;
      }

      await existing.edit({
        enabled: true,
        triggerMetadata: spec.triggerMetadata,
        actions: spec.actions,
        exemptRoles,
        reason: 'MiojoPlays AutoMod repair',
      });
      report.automodUpdated.push(spec.name);
    }
  } catch (error) {
    report.warnings.push(`AutoMod: ${error.message}`);
  }
}

export async function inspectAutoMod(guild) {
  try {
    const rules = await guild.autoModerationRules.fetch();
    return AUTOMOD_RULE_NAMES.filter((name) => !rules.some((rule) => rule.name === name));
  } catch {
    return [...AUTOMOD_RULE_NAMES];
  }
}
