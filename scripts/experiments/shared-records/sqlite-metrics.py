"""Read local SQLite plans/VM work; roll back replayed writes and never access cloud services."""
import json, sqlite3, sys
path, queries = sys.argv[1:]
# Write replay happens only in an in-memory backup, never in the evidence database.
source = sqlite3.connect('file:'+path+'?mode=ro', uri=True, cached_statements=0)
db = sqlite3.connect(':memory:', cached_statements=0)
source.backup(db)
data = json.load(open(queries))
flows = []
for flow in data['flows']:
    total = 0
    plans = []
    for query in flow['queries']:
        steps = [0]
        def tick():
            steps[0] += 1
            return 0
        db.set_progress_handler(tick, 1)
        db.execute(query['sql'], query['bindings']).fetchall()
        db.set_progress_handler(None, 0)
        total += steps[0]
        if 'SELECT r.position,' in query['sql']:
            plan = [row[3] for row in db.execute('EXPLAIN QUERY PLAN '+query['sql'], query['bindings'])]
            if plan not in plans:
                plans.append(plan)
    flows.append({'table':flow['table'],'view':flow['view'],'sqliteVmSteps':total,'plans':plans})
write_steps = [0]
def write_tick():
    write_steps[0] += 1
    return 0
db.execute('BEGIN')
db.set_progress_handler(write_tick, 1)
for statement in data['writes']:
    db.execute(statement['sql'], statement['bindings'])
db.set_progress_handler(None, 0)
db.rollback()
size = source.execute('PRAGMA page_count').fetchone()[0] * source.execute('PRAGMA page_size').fetchone()[0]
try:
    objects = [{'name':row[0],'bytes':row[1]} for row in source.execute("SELECT d.name,sum(d.pgsize) FROM dbstat d JOIN sqlite_master s ON s.name=d.name WHERE s.name LIKE 'ee_table_%' OR s.tbl_name LIKE 'ee_table_%' GROUP BY d.name")]
except sqlite3.OperationalError:
    objects = None
print(json.dumps({'sqliteVersion':sqlite3.sqlite_version,'databaseBytes':size,'objects':objects,'queryMetrics':flows,'singleRowWriteVmSteps':write_steps[0]}))
