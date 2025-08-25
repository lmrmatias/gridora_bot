// test-suite.js
// A comprehensive test suite to verify the bot's intelligence in various scenarios.

async function runTestSuite() {
    console.log("=============================");
    console.log(" B O T   A I   T E S T S ");
    console.log("=============================\n");

    const botModule = await import('./gridora_bot7.js');
    const { state, findBestSingleMove } = botModule;

    // --- TEST SCENARIOS ---
    const testCases = [
        {
            description: "Test 1: Critical Defense > Offense",
            details: "Opponent has a 4-card Straight Flush. Bot must take the completing card ('Ts') even though another card ('Ah') would give it a better immediate score (a pair of Aces).",
            myGrid: [
                ['Ac', '2d', '3h', '4s', null],
                [null, null, null, null, null],
                [null, null, null, null, null],
                [null, null, null, null, null],
                [null, null, null, null, null],
            ],
            oppGrid: [
                ['As', 'Ks', 'Qs', 'Js', null], // Opponent needs Ts for 100 points
                [null, null, null, null, null],
                [null, null, null, null, null],
                [null, null, null, null, null],
                [null, null, null, null, null],
            ],
            community: ['Ts', 'Ah', '7d', '2c', '3c', '4c', '5c'],
            expectedCard: 'Ts', // The bot MUST block.
        },
        {
            description: "Test 2: Future Potential > Immediate Gain",
            details: "Bot has a 3-card Flush draw. It can either take a card ('Qh') to make it a 4-card Flush draw (high potential, 0 immediate points), or take a '2d' to make a pair (2 immediate points, low potential). It must choose the potential.",
            myGrid: [
                ['Ah', '8h', '4h', null, null],
                ['2c', null, null, null, null],
                [null, null, null, null, null],
                [null, null, null, null, null],
                [null, null, null, null, null],
            ],
            oppGrid: Array.from({ length: 5 }, () => Array(5).fill(null)),
            community: ['Qh', '2d', '5s', '6s', '7s', '8s', '9s'],
            expectedCard: 'Qh', // The bot MUST prioritize the flush draw.
        },
        {
            description: "Test 3: Complex Offensive Choice",
            details: "Bot has two good offensive moves. Placing 'Ac' in one spot makes a Pair. Placing '7s' in another makes a different Pair. The bot must correctly identify which placement also maximizes its 'future potential' score.",
            myGrid: [
                ['Ah', 'Kh', 'Qh', null, null], // Good straight/flush potential here
                ['7c', '6d', '5s', null, null], // Less potential here
                [null, null, null, null, null],
                [null, null, null, null, null],
                [null, null, null, null, null],
            ],
            oppGrid: Array.from({ length: 5 }, () => Array(5).fill(null)),
            community: ['Ac', '7s', 'Jd', '9c', '8h', '3d', '2c'],
            expectedCard: 'Ac', // Placing the Ace in the top row creates more potential than the 7 in the second row.
        }
    ];

    let passed = 0;
    for (const testCase of testCases) {
        console.log(`--- Running: ${testCase.description} ---`);
        console.log(`    Details: ${testCase.details}`);
        
        // Manually set the game state for this specific test
        state.myGrid = testCase.myGrid;
        state.oppGrid = testCase.oppGrid;
        state.community = testCase.community;

        const decision = findBestSingleMove();

        if (decision && decision.card === testCase.expectedCard) {
            console.log(`    ✅ PASS: Bot correctly chose to play the '${decision.card}'.\n`);
            passed++;
        } else {
            console.log(`    ❌ FAIL: Bot chose '${decision ? decision.card : 'nothing'}' but was expected to choose '${testCase.expectedCard}'.\n`);
        }
    }

    console.log("--- Test Suite Complete ---");
    console.log(`Result: ${passed}/${testCases.length} tests passed.`);
    console.log("=============================");
}

runTestSuite().catch(err => console.error(err));