// Benchmark multi-agent generation (3 generators + Agent 4 evaluator) against the REAL providers
// configured in backend/.env. This spends API quota — run it deliberately.
//
// Usage (from backend/):
//   node scripts/benchmark_multiagent.js [--runs 3] [--questions 3] [--concurrency 1,3]
//                                        [--file path/to/long.txt] [--provider auto]
//
// For each concurrency level it runs the short built-in transcript (and --file, if given) --runs
// times and prints median end-to-end / generation / evaluator time, API requests, tokens, failures,
// and how often each agent's question was recommended (a check that Agent 4 isn't level-biased).
import dotenv from 'dotenv'
dotenv.config()

import fs from 'fs'
import { generateMultiAgentQuestions } from '../src/services/multiAgentService.js'

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]])
  return acc
}, []))

const runs = Number(args.runs) || 3
const numQuestions = Number(args.questions) || 3
const levels = String(args.concurrency || '1,3').split(',').map(Number).filter(Boolean)
const provider = args.provider || 'auto'

const SHORT = `Photosynthesis is the process plants use to convert light energy into chemical energy stored in glucose.
It happens mainly in the chloroplasts, which contain the green pigment chlorophyll. Chlorophyll absorbs mostly red and
blue light and reflects green, which is why leaves look green. The light-dependent reactions occur in the thylakoid
membranes and produce ATP and NADPH while splitting water and releasing oxygen. The Calvin cycle, in the stroma, uses
that ATP and NADPH to fix carbon dioxide into sugars. Stomata on the leaf surface regulate gas exchange: they let carbon
dioxide in and oxygen out, but open stomata also lose water, so plants balance photosynthesis against water loss.`

const inputs = [['short', SHORT]]
if (args.file) inputs.push([`file(${args.file})`, fs.readFileSync(args.file, 'utf8')])

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN
}

for (const [name, text] of inputs) {
  for (const c of levels) {
    process.env.MULTI_AGENT_CONCURRENCY = String(c)
    const rows = []
    for (let r = 0; r < runs; r++) {
      const t0 = Date.now()
      try {
        const res = await generateMultiAgentQuestions(text, {
          numQuestions,
          difficulty: 'medium',
          questionTypeMix: { MCQ: 50, TF: 30, MSQ: 20 },
          provider
        })
        rows.push({
          total: (Date.now() - t0) / 1000,
          generation: Number(res.timings.generation),
          evaluator: Number(res.timings.evaluator),
          requests: res.apiStats.requests,
          tokensIn: res.apiStats.inputTokens,
          tokensOut: res.apiStats.outputTokens,
          agentErrors: res.errors.length,
          evaluatorError: res.evaluatorError ? 1 : 0,
          picks: res.evaluatorResults.map(e => e.recommendedAgentId || e.status)
        })
      } catch (err) {
        rows.push({ total: (Date.now() - t0) / 1000, failed: err.message })
      }
    }

    const ok = rows.filter(r => !r.failed)
    const pickCounts = {}
    ok.flatMap(r => r.picks).forEach(p => { pickCounts[p] = (pickCounts[p] || 0) + 1 })
    console.log(`\n=== input=${name} words=${text.split(/\s+/).length} concurrency=${c} runs=${runs} questions=${numQuestions}`)
    console.table({
      'median total (s)': median(ok.map(r => r.total)),
      'median generation (s)': median(ok.map(r => r.generation)),
      'median evaluator (s)': median(ok.map(r => r.evaluator)),
      'median API requests': median(ok.map(r => r.requests)),
      'median tokens in': median(ok.map(r => r.tokensIn)),
      'median tokens out': median(ok.map(r => r.tokensOut)),
      'runs with agent errors': ok.filter(r => r.agentErrors > 0).length,
      'runs with evaluator error': ok.filter(r => r.evaluatorError).length,
      'failed runs': rows.length - ok.length
    })
    console.log('Recommendation distribution:', pickCounts)
  }
}
process.exit(0)
