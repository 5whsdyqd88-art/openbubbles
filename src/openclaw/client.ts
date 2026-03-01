/**
 * OpenClaw Gateway API client.
 * Discovers agents, delivers messages, reads session state.
 */

export interface OpenClawClientOptions {
  /** Gateway base URL (default: http://localhost:59679) */
  gatewayUrl?: string;
  /** API token for authentication */
  apiToken?: string;
  /** Request timeout in ms */
  timeoutMs?: number;
  log?: (msg: string) => void;
}

export interface OpenClawAgent {
  id: string;
  name?: string;
  emoji?: string;
  theme?: string;
}

export interface DeliverMessageOptions {
  /** Target agent ID */
  agentId: string;
  /** Sender identifier (phone/email) */
  from: string;
  /** Reply-to target (chat GUID for outbound routing) */
  to: string;
  /** Message text */
  text: string;
  /** Chat type */
  chatType: "direct" | "group";
  /** Whether this is a group chat */
  isGroup: boolean;
  /** Group chat name */
  groupName?: string;
  /** Group members */
  groupMembers?: string;
  /** Sender display name */
  senderName?: string;
  /** Media attachment paths */
  mediaPaths?: string[];
  /** Media MIME types */
  mediaTypes?: string[];
  /** Message timestamp */
  timestamp?: number;
}

export class OpenClawClient {
  private baseUrl: string;
  private apiToken: string | null;
  private timeoutMs: number;
  private log: (msg: string) => void;

  constructor(options: OpenClawClientOptions = {}) {
    this.baseUrl = (options.gatewayUrl ?? "http://localhost:59679").replace(
      /\/$/,
      "",
    );
    this.apiToken = options.apiToken ?? null;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.log = options.log ?? ((msg) => console.log(`[openclaw-client] ${msg}`));
  }

  /**
   * List available agents from the gateway.
   */
  async listAgents(): Promise<OpenClawAgent[]> {
    try {
      const res = await this.fetch("/api/agents");
      if (!res.ok) {
        this.log(`listAgents failed: ${res.status}`);
        return [];
      }
      const data = (await res.json()) as { agents?: OpenClawAgent[] };
      return data.agents ?? [];
    } catch (err) {
      this.log(`listAgents error: ${err}`);
      return [];
    }
  }

  /**
   * Check if the gateway is reachable.
   */
  async ping(): Promise<boolean> {
    try {
      const res = await this.fetch("/api/status");
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Deliver an inbound iMessage to an agent via the gateway's webhook/message endpoint.
   * This triggers the agent to process and respond to the message.
   *
   * The exact endpoint depends on how OpenClaw exposes inbound message injection.
   * We'll adapt this as we discover the right API.
   */
  async deliverMessage(options: DeliverMessageOptions): Promise<boolean> {
    const payload = {
      channel: "imessage-bridge",
      from: options.from,
      to: options.to,
      text: options.text,
      chatType: options.chatType,
      isGroup: options.isGroup,
      groupName: options.groupName,
      groupMembers: options.groupMembers,
      senderName: options.senderName,
      mediaPaths: options.mediaPaths,
      mediaTypes: options.mediaTypes,
      timestamp: options.timestamp,
      agentId: options.agentId,
    };

    try {
      const res = await this.fetch("/api/message/inbound", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        this.log(
          `deliverMessage failed: ${res.status} ${text.slice(0, 200)}`,
        );
        return false;
      }

      return true;
    } catch (err) {
      this.log(`deliverMessage error: ${err}`);
      return false;
    }
  }

  private async fetch(
    path: string,
    init?: RequestInit,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      ...(init?.headers as Record<string, string>),
    };

    if (this.apiToken) {
      headers["Authorization"] = `Bearer ${this.apiToken}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      return await fetch(url, {
        ...init,
        headers,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
