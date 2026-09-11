process.env.NODE_ENV='dev'; require('dotenv').config();
const mongoose=require('mongoose'), db=require('./db');
const SendJob=require('./models/SendJob'), Campaign=require('./models/Campaign'), CampaignRow=require('./models/CampaignRow');
const { buildTimeline, istDateKey } = require('./lib/campaignRunner');
const HOUR=3600000, DAY=86400000;
let fails=0; const t=(l,c,x='')=>{console.log(`${c?'  PASS':'  FAIL'}  ${l}${x?' — '+x:''}`);if(!c)fails++;};
const clean=async()=>{
  await SendJob.deleteMany({ 'items.to': /zz-tl\.example\.com$/ });
  const cs=await Campaign.find({name:/^ZZ TL/},{_id:1}).lean();
  await CampaignRow.deleteMany({campaignId:{$in:cs.map(c=>c._id)}});
  await Campaign.deleteMany({_id:{$in:cs.map(c=>c._id)}});
};
const item=(i,status,processedAt)=>({contactId:'c'+i,to:`p${i}@zz-tl.example.com`,name:'P'+i,
  subject:'s',body:'b',status,processedAt:processedAt||null});

(async()=>{
  await db.connect(); await clean();
  const now=Date.now();

  // 3 sent 2h ago, 2 sent 26h ago (yesterday), plus a live drip with 4 pending.
  await SendJob.create({ items:[
    item(1,'sent',new Date(now-2*HOUR)), item(2,'sent',new Date(now-2*HOUR)), item(3,'sent',new Date(now-2*HOUR)),
    item(4,'sent',new Date(now-26*HOUR)), item(5,'sent',new Date(now-26*HOUR)),
  ], status:'done', sendMode:'drip', ratePerHour:40 });

  await SendJob.create({ items:[ item(6,'pending'), item(7,'pending'), item(8,'pending'), item(9,'pending') ],
    status:'processing', sendMode:'drip', ratePerHour:2, createdAt:new Date(now) });

  // A running campaign with 5 pending rows, 2/day -> 3 future batches.
  const c=await Campaign.create({ name:'ZZ TL camp', templateKey:'x', status:'running',
    contactsPerDay:2, ratePerHour:60, runHourIst:9, stats:{pending:5,total:5} });

  console.log('\n--- hour granularity ---');
  let tl=await buildTimeline({granularity:'hour'});
  const sent=tl.buckets.reduce((a,b)=>a+b.sent,0);
  const sched=tl.buckets.reduce((a,b)=>a+b.scheduled,0);
  console.log('  sent in window:',sent,'| scheduled:',sched);
  t('3 sends 2h ago are in the past window', sent===3, 'got '+sent);
  t('the 26h-old send is outside the 24h window', sent===3);
  t('4 in-flight pending appear as scheduled', sched>=4, 'got '+sched);
  const past=tl.buckets.filter(b=>b.past).length, fut=tl.buckets.filter(b=>!b.past).length;
  t('window splits past/future', past>=24 && fut>=48, `past ${past} future ${fut}`);
  const hit=tl.buckets.find(b=>b.sent===3);
  console.log('  bucket holding them:', hit && hit.key, '| peakSent', hit && hit.peakSent);
  t('peak equals the hour total', !!hit && hit.peakSent===3);

  console.log('\n--- day granularity ---');
  tl=await buildTimeline({granularity:'day'});
  const dSent=tl.buckets.reduce((a,b)=>a+b.sent,0);
  const dSched=tl.buckets.reduce((a,b)=>a+b.scheduled,0);
  console.log('  sent:',dSent,'| scheduled:',dSched);
  t('both sends now inside the 14-day window', dSent===5, 'got '+dSent);
  t('in-flight + 5 projected campaign rows scheduled', dSched===9, 'got '+dSched+' (4 in-flight + 5 projected)');
  const today=tl.buckets.find(b=>b.key===istDateKey());
  console.log('  today bucket:', today && JSON.stringify({sent:today.sent,sched:today.scheduled,peakSent:today.peakSent}));
  t('day roll-up keeps the peak hour separate from the total',
    !!today && today.peakSent<=today.sent);
  const contiguous=tl.buckets.every((b,i,a)=>i===0||a[i].t-a[i-1].t===DAY);
  t('day series is contiguous (gaps read as zero)', contiguous);

  await clean(); await mongoose.disconnect();
  console.log(fails?`\n${fails} FAILED\n`:'\nALL TIMELINE CHECKS PASSED\n');
  process.exit(fails?1:0);
})().catch(async e=>{console.error(e); try{await clean();await mongoose.disconnect();}catch{} process.exit(1);});
