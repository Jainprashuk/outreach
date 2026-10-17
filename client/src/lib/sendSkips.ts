import type { CooldownSkip } from './api';

/**
 * One sentence per reason resetForSendApi left contacts out — each skip says WHY,
 * instead of calling every one of them "emailed in the last 24h".
 */
export function describeSkips(skipped: CooldownSkip[], cooldownLabel: string): string {
  const n = (r: CooldownSkip['reason']) => skipped.filter(c => c.reason === r).length;
  const reserved = n('in_campaign');
  const blocked = n('blocked');
  const interviewing = n('in_interview');
  const awaitingYou = n('replied');
  const cooldown = skipped.length - reserved - blocked - interviewing - awaitingYou;
  return [
    cooldown ? `${cooldown} contact${cooldown !== 1 ? 's were' : ' was'} skipped — already emailed in the last ${cooldownLabel}.` : '',
    reserved ? `${reserved} contact${reserved !== 1 ? 's are' : ' is'} already reserved by a campaign.` : '',
    blocked ? `${blocked} contact${blocked !== 1 ? 's are' : ' is'} blocklisted and won't be sent to.` : '',
    interviewing ? `${interviewing} contact${interviewing !== 1 ? 's are' : ' is'} in your interview pipeline — outreach is stopped for them.` : '',
    awaitingYou ? `${awaitingYou} contact${awaitingYou !== 1 ? 's have' : ' has'} replied and ${awaitingYou !== 1 ? 'are' : 'is'} waiting on your answer — reply from the Mailbox.` : '',
  ].filter(Boolean).join(' ');
}
