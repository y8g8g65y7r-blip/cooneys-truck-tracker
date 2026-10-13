// node test/run_matrix.js <sql files...>
// Runs the files as ONE transaction through the Management API (Cooney's GPS
// only, via supabase_mgmt.js's guard), expecting the last block to RAISE its
// "RESULTS fail=N [...]" report, which also rolls everything back. Prints the
// report as PASS/FAIL lines. Exit 0 only when fail=0.
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process')
const files = process.argv.slice(2)
const tmp = path.join(require('os').tmpdir(), 'tt_matrix_' + process.pid + '.sql')
fs.writeFileSync(tmp, 'begin;\n' + files.map(f => fs.readFileSync(f, 'utf8')).join('\n;\n'))
let out = ''
try { out = execFileSync('node', [path.join(__dirname, '..', 'supabase_mgmt.js'), 'sql', tmp], { encoding: 'utf8' }) }
catch (e) { out = (e.stdout || '') + (e.stderr || '') }
fs.unlinkSync(tmp)
let msg = out
try { msg = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)).message } catch (e) {}
const m = /RESULTS fail=(\d+) (\[[\s\S]*\])/.exec(msg)
if (!m) { console.log('NO REPORT (a statement failed before the tests ran):\n' + String(msg).slice(0, 1500)); process.exit(1) }
JSON.parse(m[2]).forEach(r => console.log((r.ok ? 'PASS ' : 'FAIL ') + r.t + (!r.ok && r.msg != null ? '  [' + r.msg + ']' : '')))
console.log('fail=' + m[1]); process.exit(m[1] === '0' ? 0 : 2)
