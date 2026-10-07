console.log('========================================');
console.log('1. Running Core State Machine Tests...');
console.log('========================================');
await import('./run.mjs');

console.log('\n========================================');
console.log('2. Running Host Service & API Tests...');
console.log('========================================');
await import('./integration.test.mjs');

console.log('\n========================================');
console.log('🎉 ALL PLUGIN TESTS PASSED SUCCESSFULLY!');
console.log('========================================');
