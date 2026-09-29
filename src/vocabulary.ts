/** Interview and tech terms that general speech recognition often mishears ("to some" for "Two Sum"). */
export const interviewTerms = [
  'LeetCode', 'Two Sum', 'Big O', 'time complexity', 'space complexity', 'hash map', 'hash table', 'linked list', 'binary search', 'binary tree',
  'dynamic programming', 'recursion', 'BFS', 'DFS', 'heap', 'trie', 'graph', 'sliding window', 'two pointers', 'STAR method',
  'system design', 'load balancer', 'microservices', 'API', 'REST', 'GraphQL', 'SQL', 'NoSQL', 'Postgres', 'Redis',
  'Kafka', 'Kubernetes', 'Docker', 'AWS', 'CI/CD', 'React', 'TypeScript', 'JavaScript', 'Python', 'Java',
];

export const parseTerms = (text: string) => text.split(/[\n,;]/).map(term => term.trim()).filter(Boolean);

/** Your own terms first, then the built-in list, deduplicated and kept within Deepgram's 100-term / ~500-token limit. */
export function keytermsFor(extra: string, limit = 100, maxCharacters = 1500) {
  const terms: string[] = []; const seen = new Set<string>(); let characters = 0;
  for (const term of [...parseTerms(extra), ...interviewTerms]) {
    const key = term.toLowerCase();
    if (seen.has(key) || term.length > 60 || characters + term.length > maxCharacters) continue;
    seen.add(key); terms.push(term); characters += term.length;
    if (terms.length === limit) break;
  }
  return terms;
}
