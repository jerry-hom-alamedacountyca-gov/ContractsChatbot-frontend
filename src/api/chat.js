import { getLoginRequest, msalInstance } from '../auth/authConfig.js';
import { getConfig } from '../config.js';

// TODO: Remove hardcoded URL before production
const HARDCODED_API_URL = '';

function shouldSkipEntraAuth() {
  const flag = (getConfig('SKIP_LOCAL_ENTRA') || '').toLowerCase();
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return false;
}

function getManualAccessToken() {
  const tokenFromEmbed = window.__AI_CHAT_CONFIG__?.token || '';
  const tokenFromConfig = getConfig('DEV_ACCESS_TOKEN') || '';
  const tokenFromStorage =
    window.sessionStorage.getItem('DEV_ACCESS_TOKEN') ||
    window.localStorage.getItem('DEV_ACCESS_TOKEN') ||
    '';
  const raw = tokenFromEmbed || tokenFromConfig || tokenFromStorage;
  if (!raw) return null;
  return raw.startsWith('Bearer ') ? raw.slice('Bearer '.length) : raw;
}

function getApiUrl() {
  return (
    HARDCODED_API_URL ||
    window.__AI_CHAT_CONFIG__?.apiUrl ||
    getConfig('API_URL') ||
    '/api/chat'
  );
}

function getApiBaseUrl() {
  return getConfig('API_BASE_URL') || '';
}

function getAgentRef() {
  return {
    name: getConfig('AGENT_NAME') || 'EBCChatbot',
    type: 'agent_reference',
  };
}

function extractCitations(parts) {
  const seen = new Set();
  const citations = [];
  for (const part of parts) {
    const annotations = part?.annotations || [];
    for (const ann of annotations) {
      if (ann.type === 'url_citation' && ann.url) {
        const key = ann.url;
        if (!seen.has(key)) {
          seen.add(key);
          citations.push({ type: 'url', url: ann.url, title: ann.title || ann.url });
        }
      } else if (ann.type === 'file_citation' && (ann.filename || ann.file_id)) {
        const key = ann.file_id || ann.filename;
        if (!seen.has(key)) {
          seen.add(key);
          citations.push({ type: 'file', fileId: ann.file_id, filename: ann.filename || ann.file_id });
        }
      }
    }
  }
  return citations;
}

function extractAssistantText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    // Top-level output_text — check for annotations in output items
    const outputItems = data?.output || [];
    const msgItem = outputItems.find(
      (item) => item?.type === 'message' && item?.role === 'assistant',
    );
    const parts = msgItem?.content || [];
    const citations = extractCitations(parts);
    return { text: data.output_text, citations };
  }

  const message = (data?.output || []).find(
    (item) => item?.type === 'message' && item?.role === 'assistant',
  );
  const parts = message?.content || [];
  const text = parts
    .filter((part) => part?.type === 'output_text' && typeof part?.text === 'string')
    .map((part) => part.text)
    .join('')
    .trim();
  const citations = extractCitations(parts);

  if (text) {
    return { text, citations };
  }

  return { text: '', citations: [] };
}

async function getAccessToken() {
  // Temporary manual override for local debugging.
  const manualToken = getManualAccessToken();
  if (manualToken) {
    return manualToken;
  }

  if (shouldSkipEntraAuth()) {
    return null;
  }

  const accounts = msalInstance.getAllAccounts();
  if (accounts.length === 0) {
    // No account — redirect to login (page will reload after auth)
    await msalInstance.loginRedirect(getLoginRequest());
    return null;
  }
  const response = await msalInstance.acquireTokenSilent({
    ...getLoginRequest(),
    account: accounts[0],
  }).catch(() => msalInstance.acquireTokenRedirect(getLoginRequest()));
  return response.accessToken;
}

async function authHeaders() {
  const token = await getAccessToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

// ── Conversations API (requires API_BASE_URL) ──

export function isConversationsEnabled() {
  return !!getApiBaseUrl();
}

export async function createApiConversation() {
  const base = getApiBaseUrl();
  const headers = await authHeaders();
  const res = await fetch(`${base}/conversations`, {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Create conversation failed ${res.status}: ${text}`);
  }
  return res.json();
}

export async function deleteApiConversation(conversationId) {
  const base = getApiBaseUrl();
  if (!base) return;
  const headers = await authHeaders();
  const res = await fetch(`${base}/conversations/${conversationId}`, {
    method: 'DELETE',
    headers,
  });
  if (!res.ok) {
    console.warn(`Delete conversation failed ${res.status}`);
  }
}

// ── Chat (supports both conversation-based and stateless modes) ──

export function streamChat(inputOrMessages, { conversationId, onToken, onCitations, onDone, onError, signal }) {
  const useConversations = typeof conversationId === 'string';

  const buildRequest = (headers) => {
    if (useConversations) {
      // Conversation-based mode — input is included in the responses call
      const base = getApiBaseUrl();
      return fetch(`${base}/responses`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          conversation: conversationId,
          agent_reference: {
            ...getAgentRef(),
            version: getConfig('AGENT_VERSION') || '8',
          },
          input: [{ role: 'user', content: inputOrMessages }],
        }),
        signal,
      });
    }
    // Stateless fallback (original behavior)
    const url = getApiUrl();
    return fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        input: inputOrMessages.map((m) => ({ role: m.role, content: m.content })),
        agent_reference: {
          ...getAgentRef(),
          version: getConfig('AGENT_VERSION') || '8',
        },
      }),
      signal,
    });
  };

  getAccessToken()
    .then((token) => {
      const headers = {
        'Content-Type': 'application/json',
      };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      return buildRequest(headers);
    })
    .then(async (res) => {
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`API error ${res.status}: ${text}`);
      }

      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('text/event-stream')) {
        // Streaming response (SSE / chunked)
        const reader = res.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          onToken(chunk);
        }
      } else {
        // JSON response (Responses API)
        const data = await res.json();
        const result = extractAssistantText(data);
        if (result.text) {
          onToken(result.text);
        }
        if (result.citations?.length) {
          onCitations?.(result.citations);
        }
      }

      onDone();
    })
    .catch((err) => {
      if (err.name === 'AbortError') return;
      onError(err);
    });
}
