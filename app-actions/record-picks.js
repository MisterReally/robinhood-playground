// const fs = require('mz/fs');
// const jsonMgr = require('../utils/json-mgr');
// const lookup = require('../utils/lookup');
// const mapLimit = require('promise-map-limit');
const getAdditionalMultipliers = require('./get-additional-multipliers');
const lookupMultiple = require('../utils/lookup-multiple');
const stratManager = require('../socket-server/strat-manager');
const Pick = require('../models/Pick');

const purchaseStocks = require('./purchase-stocks');
const sendEmail = require('../utils/send-email');
const tweeter = require('./tweeter');
const calcEmailsFromStrategy = require('../utils/calc-emails-from-strategy');
const stocktwits = require('../utils/stocktwits');
const { 
    disableMultipliers, 
    forPurchase, 
    multiplierThreshold,
    disableOnlyMinors,
    maxOrigMultiplier = Number.POSITIVE_INFINITY,
    minMultiplier = 2,
    overallMultiplierMultiplier = 1,
    onlyAvgDownOpenPositions,
    dontBuy,
    skipPurchasing
} = require('../settings');
const pmsHit = require('../utils/pms-hit');
const { emails } = require('../config');
const isJimmyPick = require('../utils/is-jimmy-pick');
const getSpyTrend = require('../utils/get-spy-trend');

const { throttle } = require('underscore')
const throttledRefreshPositions = throttle(() => {
  console.log('sending refresh positions to strat manager')
  require('../socket-server/strat-manager').refreshPositions()
}, 10000);



const handlePick = async (strategy, min, withPrices, { keys, data }) => {

    withPrices = withPrices.filter(tickerPrice => !!tickerPrice);
    if (!withPrices.length) {
        return console.log(`no stocks found for ${stratMin}`)
    }

    let forPurchaseData = {};
    let multiplier = 0;
    

    const stocksToBuy = withPrices.map(t => t.ticker);
    const [jimmyObj] = await isJimmyPick(stocksToBuy[0]);
    if (jimmyObj.isJimmyPick) {
        strategy = strategy + '-isJimmyPick';
    }
    const stratMin = `${strategy}-${min}`;
    let hits = await pmsHit(null, stratMin);
    let isRecommended = hits.includes('forPurchase');


    if (isRecommended) {
        let forPurchasePms = forPurchase
            .filter(line => line.startsWith('['))
            .map(line => line.substring(1, line.length - 1))
            .filter(pm => hits.includes(pm));
        const forPurchaseMultiplier = forPurchasePms.length;
        forPurchasePms = forPurchasePms.uniq();
 
        const {
            pmAnalysisMultiplier,
            subsetOffsetMultiplier,
            interestingWords = []
        } = await getAdditionalMultipliers(
            forPurchasePms, 
            strategy, 
            stocksToBuy
        );

        if (subsetOffsetMultiplier == undefined) return log('not ready yet');

        multiplier = Math.round(
            forPurchaseMultiplier + pmAnalysisMultiplier + subsetOffsetMultiplier
        );

        strlog({
            forPurchaseMultiplier,
            pmAnalysisMultiplier,
            subsetOffsetMultiplier
        });

        if (isNaN(multiplier)) {
            multiplier = 6;
        }
        
        const badWords = [
            // 'split',
            // 'offering', 
            'bankrupt', 
            'bankruptcy',
            'afterhours', 
            'bearish',
            'gnewssplit',
            // 'hotSt'
            // 'straightDown30',
            // 'halt'
        ];
        const matchesWord = w => strategy.includes(w) || interestingWords.includes(w);
        if (badWords.some(w => matchesWord(w)) && !strategy.includes('downer')) {
            isRecommended = false;
        }

        // const stoppedAt1 = ['derived', 'rsi'];
        // if (stoppedAt1.some(word => interestingWords.includes(word))) {
        //     multiplier = 1;
        // }

        const isMinor = strategy.includes('minorJump');
        if (isMinor) {
            multiplier = Math.max(3, multiplier);   // minFv
            if (disableOnlyMinors) {
                isRecommended = false;
            }
        }

        if (isRecommended && interestingWords.includes('isJimmyPick')) {
            hits.push('isRecommendedJimmyPick');
        }
        
        // if (multiplier < multiplierThreshold) {
        //     isRecommended = false;
        // }
        
        if (!interestingWords.includes('downer')) {     // MAX (ONLY FOR NON DOWNERS)
            multiplier = Math.round(multiplier * overallMultiplierMultiplier);
            multiplier = Math.min(multiplier, maxOrigMultiplier);
        }
        
        multiplier = Math.max(multiplier, minMultiplier);           // MIN

        
        if (strategy.includes('rsi-') || (onlyAvgDownOpenPositions && !strategy.includes('avg-downer'))) {
            const { positions = {} } = require('../socket-server/strat-manager');
            const openPosition = (positions.alpaca || []).find(pos => pos.ticker === stocksToBuy[0]);
            if (openPosition) {
                await log(`WARNING: UNRECOMMENDING ${stocksToBuy[0]} because we already have a position open, ok bucko!`)
                isRecommended = false;
            }
        }

        if (strategy.includes('drop')) {
            const { trendFromMin } = data;
            const spyTrend = await getSpyTrend();
            const limitOffset = spyTrend < 0 ? Math.abs(Math.round(spyTrend)) : 0;

            if (trendFromMin > -5 - limitOffset) {
                await log(`BELOW SPY TREND UNRECOMMENDING ${trendFromMin} with ${spyTrend} spyTrend (${limitOffset} limitOffset)`, { ticker: stocksToBuy[0] });
                isRecommended = false;
            }
        }
        
        forPurchaseData = {
            forPurchasePms, 
            multiplier, 
            forPurchaseMultiplier, 
            pmAnalysisMultiplier, 
            subsetOffsetMultiplier,
            interestingWords
        };
        
    }

    // console.log('recording', stratMin, 'strategy');
    const dateStr = stratManager.curDate;



    // last minute check to make sure we havent already recommended this at a higher price today (??? wat)
    for (let { ticker, price } of withPrices) {
        const recentPick = await Pick.getRecentPickForTicker(ticker, true, dateStr);
        if (!recentPick) continue;
        const recentRecPrice = ((recentPick.picks || []).find(pick => pick.ticker === ticker) || {}).price;
        if (recentRecPrice && recentRecPrice > price) {
            await log(`unrecommending ${ticker} because ticker was recommended today already at a higher price...`, {
                recentPick,
                recentRecPrice,
                price
            });
            return;
        }
    }





    // const dateStr = (new Date()).toLocaleDateString().split('/').join('-');

    // save to mongo
    console.log(`saving ${strategy} to mongo`);

    const pickObj = {
        date: dateStr, 
        strategyName: strategy,
        min,
        picks: withPrices,
        keys,
        data,
        isRecommended,
        ...forPurchaseData
    };

    const PickDoc = await Pick.create(pickObj);

    // strlog(PickDoc);

    // for sockets
    stratManager.newPick({
        ...pickObj,
        _id: PickDoc._id,
        stratMin,
        withPrices,
        timestamp: PickDoc.timestamp,
        keys,
    });

    
    await Promise.all([
        (async () => {

            // forPurchase
            if (isRecommended) {

                if (skipPurchasing) return log(`skipping purchasing of ${stocksToBuy.join(', ')}`);
                console.log('strategy enabled: ', stratMin, 'purchasing', stocksToBuy, multiplier);

                const includesDontBuyTicker = stocksToBuy.filter(s => dontBuy.includes(s)).length;
                await purchaseStocks({
                    strategy,
                    multiplier: !disableMultipliers ? multiplier: 1,
                    min,
                    withPrices,
                    PickDoc
                }, includesDontBuyTicker);
                !includesDontBuyTicker && throttledRefreshPositions();


                // if (withPrices.length === 1) {
                //     const [{ ticker }] = withPrices;
                //     await stocktwits.postBullish(ticker, stratMin);
                // }
                // tweeter.tweet(`BUY ${withPrices.map(({ ticker, price }) => `#${ticker} @ $${price}`).join(' and ')} - ${stratMin}`);
            }

        })(),
        (async () => {

            // for email
            const emailsToSend = Object.keys(emails)
                .reduce((acc, email) => {
                    const pms = emails[email];
                    const toSend = pms.filter(pm => 
                        hits.includes(pm)
                    );
                    return [
                        ...acc,
                        ...toSend.map(pm => ({
                            pm,
                            email
                        }))
                    ]
                }, []);
            
            for (let { email, pm } of emailsToSend) {
                const subject = stocksToBuy.join(', ');
                const body = [
                    isRecommended ? multiplier : 'notrec',
                    (withPrices[0] || {}).price,
                    ...forPurchaseData.interestingWords || [],
                    pm.includes('Jimmy') && JSON.stringify(jimmyObj, null, 2)
                ].join(' ');
                await sendEmail(
                    'force',
                    subject,
                    body,
                    email
                );
            }

        })()
    ])



    return PickDoc._id;

};





module.exports = async (strategy, min, toPurchase, trendKey = '', { keys, data } = {}) => {
    const isNotRegularHours = min < 0 || min > 390;

    const record = async (stocks, strategyName, tickerLookups) => {
        
        const withPrices = stocks.map(ticker => {
            console.log('recording', {
                ticker
            })
            const relatedLookup = tickerLookups[ticker];
            const price = isNotRegularHours ? 
                relatedLookup.afterHoursPrice || relatedLookup.lastTradePrice: 
                relatedLookup.lastTradePrice;
            return {
                ticker,
                price
            };
        });
        return handlePick(strategyName, min, withPrices, { keys, data });
    };

    if (!Array.isArray(toPurchase)) {
        console.log('obj', toPurchase)
        // its an object
        const allTickers = [...new Set(
            Object.keys(toPurchase)
                .map(strategyName => toPurchase[strategyName])
                .reduce((acc, val) => acc.concat(val), []) // flatten
        )];
        // console.log('alltickers', allTickers);
        const tickerLookups = await lookupMultiple(allTickers, true);
        // console.log('tickerLookups', tickerLookups);
        for (let strategyName of Object.keys(toPurchase)) {
            const subsetToPurchase = toPurchase[strategyName];
            const stratName = [
                strategy,
                trendKey,
                strategyName
            ].filter(Boolean).join('-');
            await record(subsetToPurchase, stratName, tickerLookups);
        }
    } else {
        console.log('array', toPurchase)
        console.log('no variety to purchase', );
        const tickerLookups = await lookupMultiple(toPurchase, true);
        const stratName = [strategy, trendKey].filter(Boolean).join('-');
        return record(toPurchase, stratName, tickerLookups);
    }

};
