const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;
const originalInfo = console.info;

function formatLog(level: string, args: any[]) {
  const message = args.map(a => 
    typeof a === 'object' ? (a instanceof Error ? a.stack : JSON.stringify(a)) : String(a)
  ).join(' ');
  
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message
  });
}

console.log = (...args) => originalLog(formatLog('info', args));
console.error = (...args) => originalError(formatLog('error', args));
console.warn = (...args) => originalWarn(formatLog('warn', args));
console.info = (...args) => originalInfo(formatLog('info', args));
