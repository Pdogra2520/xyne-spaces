import type { HttpMcpAdapter } from "../types.js";

/**
 * Read-only tools of the Atlassian Rovo MCP server. Anything not listed is
 * treated as a write and needs approval; see LINEAR_READ_TOOLS for the
 * reasoning. These are the v1 tool names; v2 exposes different ones, so until
 * this list is refreshed from a live v2 tools/list every v2 tool asks first.
 */
export const ATLASSIAN_READ_TOOLS = [
  "atlassianUserInfo",
  "getAccessibleAtlassianResources",
  "getVisibleJiraProjects",
  "getJiraProjectIssueTypesMetadata",
  "getJiraIssueTypeMetaWithFields",
  "getJiraIssue",
  "getJiraIssueRemoteIssueLinks",
  "getTransitionsForJiraIssue",
  "searchJiraIssuesUsingJql",
  "lookupJiraAccountId",
  "getConfluenceSpaces",
  "getConfluencePage",
  "getPagesInConfluenceSpace",
  "getConfluencePageFooterComments",
  "getConfluencePageInlineComments",
  "getConfluencePageDescendants",
  "searchConfluenceUsingCql",
  "search",
  "fetch",
] as const;

/**
 * Atlassian Rovo MCP v2 — Streamable HTTP at https://mcp.atlassian.com/v2/mcp.
 * Auth: OAuth 2.1 with DCR + PKCE against auth.atlassian.com. Stored credentials come from
 * routes/atlassian-remote-oauth.ts as { clientId, accessToken, refreshToken,
 * expires }. The legacy stdio `atlassian` server type was removed from the
 * seed, hence the distinct `atlassian-remote` type.
 */
export const atlassianRemoteAdapter: HttpMcpAdapter = {
  transport: "http",
  type: "atlassian-remote",
  credentialFields: [],
  healthCheck: { name: "__list_tools__", params: {} },
  writePolicy: { mode: "denylist", tools: ATLASSIAN_READ_TOOLS },
  buildHttpUrl(credentials) {
    return {
      url: "https://mcp.atlassian.com/v2/mcp",
      headers: { Authorization: `Bearer ${String(credentials["accessToken"] ?? "")}` },
    };
  },
};
