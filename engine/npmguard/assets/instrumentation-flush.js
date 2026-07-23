process.on('exit', function () {
  try {
    process.stdout.write('\n__NPMGUARD_TRACE__' + JSON.stringify(_log) + '__NPMGUARD_TRACE_END__\n');
  } catch (e) {}
});
