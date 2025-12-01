import * as core from '@actions/core';
import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  QueryExecutionState,
} from '@aws-sdk/client-athena';

/**
 * Enforce LIMIT clause on SELECT queries
 */
function enforceLimit(query: string, maxRows: number): string {
  const trimmedQuery = query.trim();

  // Check if it's a SELECT query (case-insensitive)
  const isSelect = /^\s*SELECT\s+/i.test(trimmedQuery);

  if (!isSelect) {
    // Not a SELECT query (e.g., CREATE, DROP, INSERT), don't modify
    return trimmedQuery;
  }

  // Check if query already has a LIMIT clause
  const hasLimit = /\bLIMIT\s+\d+\s*;?\s*$/i.test(trimmedQuery);

  if (hasLimit) {
    // Extract existing limit and enforce max
    const limitMatch = trimmedQuery.match(/\bLIMIT\s+(\d+)\s*;?\s*$/i);
    if (limitMatch) {
      const existingLimit = parseInt(limitMatch[1], 10);
      if (existingLimit > maxRows) {
        core.warning(`Query LIMIT ${existingLimit} exceeds max-rows ${maxRows}, enforcing LIMIT ${maxRows}`);
        return trimmedQuery.replace(/\bLIMIT\s+\d+\s*;?\s*$/i, `LIMIT ${maxRows}`);
      }
    }
    return trimmedQuery;
  }

  // Add LIMIT clause
  core.info(`Enforcing LIMIT ${maxRows} on SELECT query`);
  const hasSemicolon = trimmedQuery.endsWith(';');
  const baseQuery = hasSemicolon ? trimmedQuery.slice(0, -1).trim() : trimmedQuery;
  return `${baseQuery} LIMIT ${maxRows}`;
}

/**
 * Wait for query execution to complete
 */
async function waitForQueryExecution(
  athenaClient: AthenaClient,
  queryExecutionId: string,
  timeoutSeconds: number
): Promise<any> {
  const startTime = Date.now();
  const timeoutMs = timeoutSeconds * 1000;

  while (true) {
    const response = await athenaClient.send(
      new GetQueryExecutionCommand({ QueryExecutionId: queryExecutionId })
    );

    const state = response.QueryExecution?.Status?.State;
    core.info(`Query state: ${state}`);

    if (state === QueryExecutionState.SUCCEEDED) {
      return response.QueryExecution;
    }

    if (state === QueryExecutionState.FAILED || state === QueryExecutionState.CANCELLED) {
      const reason = response.QueryExecution?.Status?.StateChangeReason;
      throw new Error(`Query ${state}: ${reason}`);
    }

    // Check timeout
    if (Date.now() - startTime > timeoutMs) {
      throw new Error(`Query execution timed out after ${timeoutSeconds} seconds`);
    }

    // Wait before checking again
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

/**
 * Fetch query results
 */
async function fetchQueryResults(
  athenaClient: AthenaClient,
  queryExecutionId: string,
  maxRows: number
): Promise<any[]> {
  const results: any[] = [];
  let nextToken: string | undefined;

  // Fetch first page
  const firstPage = await athenaClient.send(
    new GetQueryResultsCommand({
      QueryExecutionId: queryExecutionId,
      MaxResults: Math.min(maxRows + 1, 1000), // +1 to account for header row
    })
  );

  const rows = firstPage.ResultSet?.Rows || [];

  if (rows.length === 0) {
    return [];
  }

  // First row is the header
  const headerRow = rows[0];
  const columnNames = headerRow.Data?.map(col => col.VarCharValue || '') || [];

  // Convert remaining rows to objects
  for (let i = 1; i < rows.length && results.length < maxRows; i++) {
    const row = rows[i];
    const rowData: any = {};

    row.Data?.forEach((col, idx) => {
      const columnName = columnNames[idx];
      rowData[columnName] = col.VarCharValue || null;
    });

    results.push(rowData);
  }

  // Fetch additional pages if needed
  nextToken = firstPage.NextToken;

  while (nextToken && results.length < maxRows) {
    const page = await athenaClient.send(
      new GetQueryResultsCommand({
        QueryExecutionId: queryExecutionId,
        NextToken: nextToken,
        MaxResults: Math.min(maxRows - results.length, 1000),
      })
    );

    const pageRows = page.ResultSet?.Rows || [];

    for (const row of pageRows) {
      if (results.length >= maxRows) break;

      const rowData: any = {};
      row.Data?.forEach((col, idx) => {
        const columnName = columnNames[idx];
        rowData[columnName] = col.VarCharValue || null;
      });

      results.push(rowData);
    }

    nextToken = page.NextToken;
  }

  return results;
}

/**
 * Main action entry point
 */
async function run(): Promise<void> {
  try {
    // Get inputs
    const query = core.getInput('query', { required: true });
    const database = core.getInput('database', { required: true });
    const workgroup = core.getInput('workgroup') || 'primary';
    const outputLocation = core.getInput('output-location') || undefined;
    const maxRows = parseInt(core.getInput('max-rows') || '1000', 10);
    const catalog = core.getInput('catalog') || 'AwsDataCatalog';
    const waitTimeout = parseInt(core.getInput('wait-timeout-seconds') || '300', 10);

    core.info(`Executing Athena query in database: ${database}`);
    core.info(`Workgroup: ${workgroup}`);
    core.info(`Max rows: ${maxRows}`);

    // Enforce LIMIT clause
    const enforcedQuery = enforceLimit(query, maxRows);

    // Create Athena client
    const athenaClient = new AthenaClient({});

    // Start query execution
    const startResponse = await athenaClient.send(
      new StartQueryExecutionCommand({
        QueryString: enforcedQuery,
        QueryExecutionContext: {
          Database: database,
          Catalog: catalog,
        },
        WorkGroup: workgroup,
        ResultConfiguration: outputLocation ? { OutputLocation: outputLocation } : undefined,
      })
    );

    const queryExecutionId = startResponse.QueryExecutionId!;
    core.info(`Query execution started: ${queryExecutionId}`);

    // Wait for completion
    core.info('Waiting for query to complete...');
    const execution = await waitForQueryExecution(athenaClient, queryExecutionId, waitTimeout);

    const state = execution.Status?.State;
    const dataScanned = execution.Statistics?.DataScannedInBytes || 0;
    const executionTime = execution.Statistics?.EngineExecutionTimeInMillis || 0;

    core.info(`Query completed: ${state}`);
    core.info(`Data scanned: ${dataScanned} bytes (${(dataScanned / 1024 / 1024).toFixed(2)} MB)`);
    core.info(`Execution time: ${executionTime} ms`);

    // Fetch results
    core.info('Fetching query results...');
    const results = await fetchQueryResults(athenaClient, queryExecutionId, maxRows);

    core.info(`Retrieved ${results.length} rows`);

    // Set outputs
    core.setOutput('query-execution-id', queryExecutionId);
    core.setOutput('state', state);
    core.setOutput('data-scanned-bytes', dataScanned.toString());
    core.setOutput('execution-time-ms', executionTime.toString());
    core.setOutput('results', JSON.stringify(results));
    core.setOutput('result-count', results.length.toString());

    core.info('✓ Action completed successfully');
  } catch (error) {
    core.error('Action failed with error:');

    if (error instanceof Error) {
      core.error(`Error: ${error.message}`);

      if (error.stack) {
        core.error('Stack trace:');
        core.error(error.stack);
      }

      // Check for AWS SDK specific errors
      if ('Code' in error || '$metadata' in error) {
        core.error('AWS SDK Error Details:');
        const awsError = error as any;

        if (awsError.Code) {
          core.error(`  Error Code: ${awsError.Code}`);
        }
        if (awsError.$metadata) {
          core.error(`  HTTP Status: ${awsError.$metadata.httpStatusCode}`);
          core.error(`  Request ID: ${awsError.$metadata.requestId}`);
        }
        if (awsError.message) {
          core.error(`  Message: ${awsError.message}`);
        }
      }

      core.setFailed(`Action failed: ${error.message}`);
    } else {
      core.error(`Unknown error type: ${typeof error}`);
      core.error(`Error value: ${JSON.stringify(error, null, 2)}`);
      core.setFailed('An unknown error occurred - check logs for details');
    }
  }
}

// Run the action
run();
