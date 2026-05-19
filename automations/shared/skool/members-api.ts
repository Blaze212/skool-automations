import type pino from 'pino';
import type { SkoolMember, RawMemberData } from './types.js';

interface SurveyEntry {
  question: string;
  answer: string;
}

interface SurveyPayload {
  survey: SurveyEntry[];
}

function parseSurvey(raw: string | undefined): {
  currentSituation: string;
  mainGoal: string;
  surveyEmail: string;
} {
  const empty = { currentSituation: '', mainGoal: '', surveyEmail: '' };
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw) as SurveyPayload;
    const entries = parsed.survey ?? [];
    const find = (q: string) => entries.find((e) => e.question === q)?.answer ?? '';
    return {
      currentSituation: find('What best describes your current situation?'),
      mainGoal: find("What's the main goal in the next 6–12 months?"),
      surveyEmail: find("What's your email address?"),
    };
  } catch {
    return empty;
  }
}

const SKOOL_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Origin: 'https://www.skool.com',
  Referer: 'https://www.skool.com/',
};

async function extractBuildId(cookies: string, group: string, log?: pino.Logger): Promise<string> {
  log?.info({ group }, 'fetching members page to extract buildId');
  const res = await fetch(`https://www.skool.com/${group}/-/members`, {
    headers: { ...SKOOL_HEADERS, Cookie: cookies },
  });
  if (!res.ok) throw new Error(`Members page fetch failed: ${res.status}`);
  const html = await res.text();
  const match = html.match(/"buildId"\s*:\s*"([^"]+)"/);
  if (!match?.[1]) throw new Error('Could not extract Next.js buildId from members page');
  log?.info({ buildId: match[1] }, 'extracted buildId');
  return match[1];
}

async function fetchMembersPage(
  cookies: string,
  buildId: string,
  group: string,
  page: number,
  log?: pino.Logger,
): Promise<{ members: RawMemberData[]; totalPages: number }> {
  const url =
    `https://www.skool.com/_next/data/${buildId}/${group}/-/members.json` +
    `?group=${group}&page=${page}`;
  log?.info({ page, url }, 'fetching members page');
  const res = await fetch(url, {
    headers: { ...SKOOL_HEADERS, Cookie: cookies },
  });
  if (!res.ok) throw new Error(`Members page ${page} fetch failed: ${res.status}`);

  const json = (await res.json()) as {
    pageProps?: {
      renderData?: { members?: RawMemberData[] };
      totalPages?: number;
      itemsPerPage?: number;
    };
  };

  log?.debug({ page, keys: Object.keys(json.pageProps ?? {}) }, 'members page response keys');

  const members = json.pageProps?.renderData?.members ?? [];
  const totalPages = json.pageProps?.totalPages ?? 1;
  log?.info({ page, count: members.length, totalPages }, 'page fetched');

  return { members, totalPages };
}

function normalizeRawMember(raw: RawMemberData): SkoolMember {
  const { currentSituation, mainGoal, surveyEmail } = parseSurvey(raw.member.metadata?.survey);
  return {
    skoolId: raw.id,
    name: `${raw.firstName} ${raw.lastName}`.trim(),
    joinDate: raw.member.createdAt,
    lastLoginDate: raw.member.lastOffline,
    email: surveyEmail || raw.email || '',
    currentSituation,
    mainGoal,
  };
}

export async function fetchAllMembers(options: {
  group: string;
  cookies: string;
  maxPages?: number;
  log?: pino.Logger;
}): Promise<SkoolMember[]> {
  const { group, cookies, maxPages, log } = options;

  const buildId = await extractBuildId(cookies, group, log);
  const allMembers: SkoolMember[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    const result = await fetchMembersPage(cookies, buildId, group, page, log);
    if (page === 1) totalPages = result.totalPages;
    for (const raw of result.members) {
      allMembers.push(normalizeRawMember(raw));
    }
    page++;
  } while (page <= totalPages && (maxPages === undefined || page <= maxPages));

  log?.info({ total: allMembers.length }, 'fetchAllMembers complete');
  return allMembers;
}
