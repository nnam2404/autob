import { ethers } from "ethers";
import 'dotenv/config';
import fs from "fs";

const BSC_WSS_URL = process.env.BSC_WSS_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!BSC_WSS_URL || !PRIVATE_KEY) {
    console.error("Missing BSC_WSS_URL or PRIVATE_KEY in .env");
    process.exit(1);
}

const provider = new ethers.WebSocketProvider(BSC_WSS_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// === Addresses & ABIs ===
const FactoryAddress = "0xf9416a6098dd4accca3099fc82a4824915ac6536".toLowerCase();
const SaleContractAddress = "0x20be1319c5604d272fb828a9dccd38487e973cb8";

const SaleContractAbi = [
    'function buy(address token, uint256 fundingAmount, uint256 minTokensOut) external payable',
    'function sell(address token, uint256 tokenAmount, uint256 minFundingOut) external'
];

const ERC20_ABI = [
    "event Transfer(address indexed from, address indexed to, uint256 value)",
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)"
];

const sale = new ethers.Contract(SaleContractAddress, SaleContractAbi, wallet);

// === Persistence (avoid double buys & remember sells) ===
const DB_FILE = "./purchased.json";
function loadDB() {
    try {
        return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    } catch {
        return {}; // { [tokenAddrLower]: { boughtAt, buyTx, soldAt?, sellTx? } }
    }
}
function saveDB() {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
const db = loadDB();

// In-memory guards (avoid re-entrancy while a token is being processed)
const processing = new Set(); // tokenAddrs lowercased

// === Config ===
const BUY_BNB = "0.02";              // 0.02 BNB buy
const GAS_LIMIT_BUY = 300_000n;
const GAS_LIMIT_APPROVE = 120_000n;
const GAS_LIMIT_SELL = 300_000n;
const CONFIRMATIONS = 1;             // wait for 1 conf
const SELL_DELAY_MS = 5 * 60 * 1000; // 10 minutes
const MIN_TOKENS_OUT = 0n;           // set your slippage rule here if needed
const MIN_FUNDING_OUT = 0n;          // set your slippage rule here if needed

// === Helpers ===
const transferTopic = ethers.id("Transfer(address,address,uint256)");
const addrEq = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();

async function scheduleAutoSell(tokenAddr) {
    setTimeout(async () => {
        try {
            const token = new ethers.Contract(tokenAddr, ERC20_ABI, wallet);
            const [dec, bal] = await Promise.all([
                token.decimals().catch(() => 18), // fallback
                token.balanceOf(wallet.address),
            ]);

            if (bal === 0n) {
                console.log(`ℹ️  No balance to sell for ${tokenAddr}`);
                return;
            }

            // Approve if needed
            const allowance = await token.allowance(wallet.address, SaleContractAddress);
            if (allowance < bal) {
                console.log(`📝 Approving ${tokenAddr}…`);
                const txApprove = await token.approve(SaleContractAddress, bal, { gasLimit: GAS_LIMIT_APPROVE });
                console.log(`Approve tx: ${txApprove.hash}`);
                const rA = await txApprove.wait(CONFIRMATIONS);
                if (!rA?.status) {
                    console.log(`❌ Approve failed for ${tokenAddr}`);
                    return;
                }
            }

            // Sell
            console.log(`💸 Selling ${tokenAddr} amount=${bal.toString()} (decimals=${dec})…`);
            const txSell = await sale.sell(tokenAddr, bal, MIN_FUNDING_OUT, { gasLimit: GAS_LIMIT_SELL });
            console.log(`Sell tx sent: ${txSell.hash}`);
            const rS = await txSell.wait(CONFIRMATIONS);
            if (rS?.status) {
                console.log(`✅ Sold ${tokenAddr}: ${txSell.hash}`);
                db[tokenAddr.toLowerCase()] = {
                    ...(db[tokenAddr.toLowerCase()] || {}),
                    soldAt: Date.now(),
                    sellTx: txSell.hash,
                };
                saveDB();
            } else {
                console.log(`❌ Sell reverted for ${tokenAddr}: ${txSell.hash}`);
            }
        } catch (e) {
            console.error(`Sell error for ${tokenAddr}:`, e);
        }
    }, SELL_DELAY_MS);
}

async function handleNewToken(tokenAddr, factoryRecipient) {
    const key = tokenAddr.toLowerCase();
    if (db[key]?.buyTx) {
        // already bought in a previous run
        return;
    }
    if (processing.has(key)) return;
    processing.add(key);

    try {
        console.log("🔥 New token detected:", tokenAddr, "minted to factory:", factoryRecipient);

        const valueWei = ethers.parseEther(BUY_BNB);
        const tx = await sale.buy(tokenAddr, valueWei, MIN_TOKENS_OUT, {
            value: valueWei,
            gasLimit: GAS_LIMIT_BUY
        });

        console.log("🛒 Buy tx sent:", tx.hash);
        const r = await tx.wait(CONFIRMATIONS);

        if (r?.status) {
            console.log("✅ Buy success:", tx.hash);

            db[key] = {
                boughtAt: Date.now(),
                buyTx: tx.hash,
                soldAt: db[key]?.soldAt,
                sellTx: db[key]?.sellTx,
            };
            saveDB();

            // Schedule auto-sell in 10 minutes
            scheduleAutoSell(tokenAddr);
        } else {
            console.log("❌ Buy reverted:", tx.hash);
        }
    } catch (err) {
        console.error("Buy error:", err);
    } finally {
        processing.delete(key);
    }
}

// === Event subscription ===
// We listen to ALL Transfer events and filter for mints to the factory address.
provider.on({ topics: [transferTopic] }, async (log) => {
    try {
        const parsed = iface.parseLog(log); // { name: 'Transfer', args: [from,to,value] }
        const { from, to } = parsed.args;

        if (addrEq(from, ethers.ZeroAddress) && addrEq(to, FactoryAddress)) {
            const tokenAddr = log.address; // the ERC20 token that emitted this Transfer
            // Avoid duplicate triggers if same log re-appears
            if (!db[tokenAddr.toLowerCase()]?.buyTx && !processing.has(tokenAddr.toLowerCase())) {
                await handleNewToken(tokenAddr, to);
            }
        }
    } catch (err) {
        // Many logs won't be the Transfer we expect; parse errors are normal for other contracts
        // but since we filtered by topic it's mostly safe. Still, keep it quiet except real issues.
        // console.error("Parse/Filter error:", err);
    }
});

// === Optional: on start, resume selling any tokens that were bought but not yet sold ===
(async () => {
    for (const [token, rec] of Object.entries(db)) {
        if (rec.buyTx && !rec.sellTx) {
            console.log(`⏳ Scheduling sell for previously bought token ${token} (in 10 minutes)…`);
            scheduleAutoSell(token);
        }
    }
})();
