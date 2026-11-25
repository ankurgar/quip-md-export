declare const __E2E__: boolean;

const GUARD_RULE_ID = 1;

/** RE2 pattern for the URLs whose non-GET requests are blocked. Loopback is only included in test builds. */
export function guardPattern(includeLoopback: boolean): string {
  const hosts = ['([a-z0-9-]+\\.)?quip\\.com', ...(includeLoopback ? ['127\\.0\\.0\\.1(:[0-9]+)?'] : [])];
  return `^https?://(${hosts.join('|')})/`;
}

export interface GuardStatus {
  active: boolean;
  detail: string;
}

/**
 * Second line of defence behind the client's own allow-list: the browser itself blocks any
 * non-GET request this extension tries to send to Quip. Even a bug could not edit a document.
 */
export async function installReadOnlyGuard(): Promise<GuardStatus> {
  const dnr = typeof chrome !== 'undefined' ? chrome.declarativeNetRequest : undefined;
  if (!dnr?.updateDynamicRules) return { active: false, detail: 'declarativeNetRequest is unavailable in this browser' };
  try {
    await dnr.updateDynamicRules({
      removeRuleIds: [GUARD_RULE_ID],
      addRules: [
        {
          id: GUARD_RULE_ID,
          priority: 1,
          action: { type: 'block' as chrome.declarativeNetRequest.RuleActionType },
          condition: {
            regexFilter: guardPattern(__E2E__),
            requestMethods: ['post', 'put', 'delete', 'patch'] as chrome.declarativeNetRequest.RequestMethod[],
            initiatorDomains: [chrome.runtime.id],
          },
        },
      ],
    });
    return { active: true, detail: 'The browser blocks every non-GET request this extension sends to Quip.' };
  } catch (err) {
    return { active: false, detail: `Could not install the browser-level guard: ${err instanceof Error ? err.message : String(err)}` };
  }
}
