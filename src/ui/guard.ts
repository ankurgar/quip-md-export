const GUARD_RULE_ID = 1;

/** Methods that can change something on a server. GET, HEAD and OPTIONS stay allowed. */
const WRITE_METHODS = ['post', 'put', 'delete', 'patch', 'connect', 'other'];

const RESOURCE_TYPES = [
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'webtransport',
  'webbundle',
  'other',
];

export type GuardRule = chrome.declarativeNetRequest.Rule;

/**
 * Blocks every request that is not a plain read, to any web address, when it comes from this
 * extension. The extension has no reason to change anything anywhere, so the rule is not limited to Quip.
 */
export function guardRule(extensionId: string): GuardRule {
  return {
    id: GUARD_RULE_ID,
    priority: 1,
    action: { type: 'block' as chrome.declarativeNetRequest.RuleActionType },
    condition: {
      regexFilter: '^https?://',
      requestMethods: WRITE_METHODS as chrome.declarativeNetRequest.RequestMethod[],
      resourceTypes: RESOURCE_TYPES as chrome.declarativeNetRequest.ResourceType[],
      initiatorDomains: [extensionId],
    },
  };
}

export interface GuardStatus {
  active: boolean;
  detail: string;
}

/**
 * Second line of defence behind the client's own allow-list: the browser itself refuses any write
 * request this extension tries to send. Even a bug could not edit a document.
 */
export async function installReadOnlyGuard(): Promise<GuardStatus> {
  const dnr = typeof chrome !== 'undefined' ? chrome.declarativeNetRequest : undefined;
  if (!dnr?.updateDynamicRules) return { active: false, detail: 'declarativeNetRequest is unavailable in this browser' };
  try {
    await dnr.updateDynamicRules({ removeRuleIds: [GUARD_RULE_ID], addRules: [guardRule(chrome.runtime.id)] });
    return { active: true, detail: 'The browser blocks every POST, PUT, PATCH and DELETE this extension sends to any address.' };
  } catch (err) {
    return { active: false, detail: `Could not install the browser-level guard: ${err instanceof Error ? err.message : String(err)}` };
  }
}
