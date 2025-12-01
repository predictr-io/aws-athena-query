# AWS Athena Query Action

GitHub Action to execute SQL queries on AWS Athena and fetch results with automatic LIMIT clause enforcement for safety.

## Features

- Execute SQL queries on AWS Athena
- Automatic LIMIT clause enforcement on SELECT queries (default: 1000 rows)
- Fetch and return query results as JSON
- Wait for query completion with configurable timeout
- Comprehensive query statistics (data scanned, execution time)
- Support for multiple catalogs and workgroups

## Usage

```yaml
- name: Query Athena
  uses: predictr-io/aws-athena-query@v0
  with:
    query: 'SELECT * FROM my_table WHERE date = current_date'
    database: 'my_database'
    max-rows: 100
```

## Authentication

This action requires AWS credentials to be configured. Use the official AWS configure credentials action:

```yaml
- uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: arn:aws:iam::123456789012:role/GitHubActionsRole
    aws-region: us-east-1

- uses: predictr-io/aws-athena-query@v0
  with:
    query: 'SELECT * FROM my_table'
    database: 'my_database'
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `query` | Yes | - | SQL query to execute (LIMIT enforced on SELECT) |
| `database` | Yes | - | Athena database name |
| `workgroup` | No | `primary` | Athena workgroup name |
| `output-location` | No | - | S3 location for query results (s3://bucket/path/) |
| `max-rows` | No | `1000` | Maximum rows to return (enforced via LIMIT) |
| `catalog` | No | `AwsDataCatalog` | Data catalog name |
| `wait-timeout-seconds` | No | `300` | Max time to wait for query completion |

## Outputs

| Output | Description |
|--------|-------------|
| `query-execution-id` | Athena query execution ID |
| `state` | Final query state (SUCCEEDED, FAILED, CANCELLED) |
| `data-scanned-bytes` | Amount of data scanned by the query in bytes |
| `execution-time-ms` | Query execution time in milliseconds |
| `results` | Query results as JSON array of objects |
| `result-count` | Number of rows returned |

## LIMIT Clause Enforcement

For safety, this action automatically enforces a LIMIT clause on SELECT queries:

### Automatic LIMIT Addition
```sql
-- Input query
SELECT * FROM users WHERE active = true

-- Executed query (with max-rows: 1000)
SELECT * FROM users WHERE active = true LIMIT 1000
```

### LIMIT Override Protection
```sql
-- Input query with LIMIT 5000
SELECT * FROM users LIMIT 5000

-- Executed query (max-rows: 1000 enforced)
SELECT * FROM users LIMIT 1000
```

### Non-SELECT Queries
CREATE, DROP, INSERT, and other non-SELECT queries are not modified:
```sql
-- These queries are executed as-is (no LIMIT added)
CREATE TABLE my_table AS SELECT * FROM source
DROP TABLE old_table
INSERT INTO table VALUES (...)
```

## Examples

### Basic Query

```yaml
- name: Query recent events
  id: query
  uses: predictr-io/aws-athena-query@v0
  with:
    query: |
      SELECT event_type, COUNT(*) as count
      FROM events
      WHERE date = current_date
      GROUP BY event_type
    database: 'analytics'
    max-rows: 100

- name: Process results
  run: |
    echo "Query scanned: ${{ steps.query.outputs.data-scanned-bytes }} bytes"
    echo "Results: ${{ steps.query.outputs.results }}"
```

### Query with Custom Workgroup

```yaml
- name: Query with custom workgroup
  uses: predictr-io/aws-athena-query@v0
  with:
    query: 'SELECT * FROM large_table WHERE partition = "2024-01-01"'
    database: 'production'
    workgroup: 'high-memory-workgroup'
    output-location: 's3://my-bucket/athena-results/'
    max-rows: 5000
    wait-timeout-seconds: 600
```

### Process Results in Workflow

```yaml
- name: Query user data
  id: query
  uses: predictr-io/aws-athena-query@v0
  with:
    query: 'SELECT user_id, email FROM users WHERE status = "active"'
    database: 'users_db'

- name: Parse and use results
  run: |
    echo '${{ steps.query.outputs.results }}' > results.json

    # Process with jq
    cat results.json | jq '.[] | select(.email | contains("@example.com"))'

    # Count results
    echo "Found ${{ steps.query.outputs.result-count }} active users"
```

### Query Multiple Tables

```yaml
- name: Query customer orders
  uses: predictr-io/aws-athena-query@v0
  with:
    query: |
      SELECT
        c.customer_id,
        c.name,
        COUNT(o.order_id) as order_count,
        SUM(o.total) as total_spent
      FROM customers c
      LEFT JOIN orders o ON c.customer_id = o.customer_id
      WHERE o.order_date >= current_date - interval '30' day
      GROUP BY c.customer_id, c.name
      ORDER BY total_spent DESC
    database: 'sales'
    max-rows: 500
```

### Cross-Catalog Query

```yaml
- name: Query external data catalog
  uses: predictr-io/aws-athena-query@v0
  with:
    query: 'SELECT * FROM external_table'
    database: 'external_db'
    catalog: 'MyDataCatalog'
    workgroup: 'external-workgroup'
```

### DDL Operations (No LIMIT Enforced)

```yaml
- name: Create table from query
  uses: predictr-io/aws-athena-query@v0
  with:
    query: |
      CREATE TABLE daily_summary AS
      SELECT
        date,
        category,
        COUNT(*) as event_count
      FROM events
      WHERE date = current_date
      GROUP BY date, category
    database: 'analytics'
```

## Error Handling

The action provides detailed error information:

```yaml
- name: Query with error handling
  id: query
  continue-on-error: true
  uses: predictr-io/aws-athena-query@v0
  with:
    query: 'SELECT * FROM possibly_missing_table'
    database: 'test_db'

- name: Handle query failure
  if: steps.query.outcome == 'failure'
  run: |
    echo "Query failed"
    echo "Check the logs for detailed error information"
```

## Query Statistics

The action provides useful statistics about query execution:

```yaml
- name: Query with statistics
  id: query
  uses: predictr-io/aws-athena-query@v0
  with:
    query: 'SELECT * FROM large_table'
    database: 'data_warehouse'

- name: Log statistics
  run: |
    echo "Data scanned: ${{ steps.query.outputs.data-scanned-bytes }} bytes"
    echo "Execution time: ${{ steps.query.outputs.execution-time-ms }} ms"
    echo "Rows returned: ${{ steps.query.outputs.result-count }}"
    echo "Query ID: ${{ steps.query.outputs.query-execution-id }}"
```

## Best Practices

1. **Use Partitions**: Always filter on partition columns to minimize data scanned
   ```sql
   SELECT * FROM events WHERE date = '2024-01-01' AND hour = '12'
   ```

2. **Limit Columns**: Select only the columns you need
   ```sql
   SELECT user_id, name FROM users  -- Good
   SELECT * FROM users              -- Avoid
   ```

3. **Set Appropriate max-rows**: Set a reasonable limit for your use case
   ```yaml
   max-rows: 100  # For small result sets
   max-rows: 10000  # For larger exports (be cautious of GitHub Actions limits)
   ```

4. **Use Workgroups**: Configure workgroups with output locations and cost controls
   ```yaml
   workgroup: 'cost-controlled-workgroup'
   output-location: 's3://query-results-bucket/path/'
   ```

5. **Handle Timeouts**: Set appropriate timeouts for complex queries
   ```yaml
   wait-timeout-seconds: 600  # 10 minutes for complex queries
   ```

## Limitations

- Maximum result size is limited by GitHub Actions' output size limits (~1MB)
- For very large result sets, use Athena's S3 output directly instead
- Query results are stored in memory; very large result sets may cause issues
- The `max-rows` parameter caps results at the specified limit

## License

MIT
