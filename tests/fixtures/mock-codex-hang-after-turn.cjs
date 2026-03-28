const stdinChunks = [];

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => stdinChunks.push(chunk));
process.stdin.on("end", () => {
  const prompt = stdinChunks.join("");
  const tokenMatch = prompt.match(/Finish with this token on its own line:\s*(\S+)/);
  const token = tokenMatch ? tokenMatch[1] : "__MISSING_TOKEN__";
  const response = [
    '<codex_research_team-response>',
    JSON.stringify({
      shouldReply: true,
      workingNotes: ["ok"],
      teamMessages: [{ content: "handoff", targetAgentIds: [], subgoalIds: [] }],
      completion: "continue",
    }),
    "</codex_research_team-response>",
    token,
  ].join("\n");

  process.stdout.write(`${JSON.stringify({ type: "turn.started" })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: response } })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 12, cached_input_tokens: 0, output_tokens: 34 } })}\n`);
  setInterval(() => {}, 1000);
});
