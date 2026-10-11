// Run after compilation with Playwright on NODE_PATH and CHROMIUM_PATH set if needed.
// Screenshots are retained; the temporary project uses the caller-owned TMPDIR.
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),vm=require('vm');
const {chromium}=require('playwright');
const root=path.resolve(__dirname, '../..');
const base=fs.mkdtempSync(path.join(require('os').tmpdir(), 'solomap-report-browser-'));
const project=path.join(base, 'project');
const artifacts=path.join(root,'output/playwright/462-native-reports');
const dataRoot=path.join(base,'.solomap-global');
(async()=>{
 const closers=[];
 try {
 fs.mkdirSync(artifacts,{recursive:true});
 fs.mkdirSync(path.join(project,'src'),{recursive:true});
 const {store}=await require('../analysis-fixture.js').openAnalysisOwner({after:fn=>closers.push(fn)},dataRoot,[{path:project,name:'SoloMap'}]);
 for(let i=0;i<12;i++){const dir=path.join(project,'src',`module${i}WithLongNameThatMustRemainReadable`);fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'index.js'),'export const result = true;\n');}
 const {registerLearningTask,writeLearningJson}=require(path.join(root,'out/taskReport.js'));
 const runDir=path.join(project,'.solopreneur/agent-runs/__solo__/1');
 const taskId=registerLearningTask(project,{executionLogId:1,runDir,userMessage:'原始需求必须按需查看。'.repeat(100),startedAt:'2026-09-08'});
 const body={summary:'导出可以按日期筛选，用户只需保存想要的内容。',unmetRequirements:['仍需确认导出时默认选择的日期。'],decisions:['保留用户选择。'],corrections:[],verification:['过程日志只在按需查看时显示。'.repeat(40)],commits:[],experienceUsage:[],lessons:[]};
 const legacySummary='长过程说明。'.repeat(200);
 for(let i=1;i<=2;i++)writeLearningJson(path.join(runDir,`task-report-${i}.json`),{schemaVersion:1,projectPath:project,taskId,executionLogId:1,turnId:`${i}:complete`,createdAt:`2026-09-0${i}`,report:{...body,summary:i===2?legacySummary:body.summary}});
 await require(path.join(root,'out/projectDataMigration.js')).importAgentRuns(store,path.join(project,'.solopreneur/agent-runs'),{projectRoot:project});
 fs.renameSync(path.join(project,'.solopreneur/agent-runs'),path.join(base,'retained-history'));
 await require(path.join(root,'out/projectGrowth.js')).refreshProjectGrowthSnapshot(project,root,{scanReason:'browser-regression',globalDataPath:dataRoot});
 const view=await require(path.join(root,'out/projectGrowth.js')).getProjectGrowthView(project,root,{refreshIfMissing:false,globalDataPath:dataRoot});
 const {queryGrowthReports}=require(path.join(root,'out/growthReports.js'));
 const tasks=await queryGrowthReports(project,root,{},dataRoot);const task=tasks.tasks[0];assert.ok(task);
 const turns=await queryGrowthReports(project,root,{taskId:task.taskId},dataRoot);
 const html=require(path.join(root,'out/projectGrowthWebview.js')).getProjectGrowthWebviewHtml({cspSource:'self',asWebviewUri:u=>`http://solomap.test${u}`},{extensionUri:{fsPath:root}},view,'SoloMap',true,[{name:'SoloMap',path:project}]);
 for(const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(m[1]);
 fs.writeFileSync(path.join(artifacts,'growth.html'),html);
 const compiled=fs.readFileSync(path.join(root,'out/extension.js'),'utf8');
 const captureStart=compiled.indexOf('async function captureConversationLaunchTarget(');
 const captureEnd=compiled.indexOf('async function resumeOrdinaryConversation(',captureStart);
 assert.ok(captureStart>0 && captureEnd>captureStart);
 const captureTarget=new vm.Script(compiled.slice(captureStart,captureEnd)+'\ncaptureConversationLaunchTarget(context,workspaceRoot,globalDataPath,settings)');
 const start=compiled.indexOf("case 'growth.reports':");
 const handler=new vm.Script(`(async()=>{switch(message.command){${compiled.slice(start,compiled.indexOf("case 'project.select':",start))}}})()`);
 const launches=[],settled=[];
 const hostPanel={webview:{postMessage:message=>settled.push(message)}};
 const continueAction=message=>handler.runInNewContext({message,context:{extensionPath:root},path,
  activeProjectGrowthPanel:hostPanel,activeProjectGrowthPath:project,projectGrowthLoadSequence:1,growthReportActions:new Set(),
  getProjects:()=>[{path:project}],getPersistedSettings:()=>({globalDataPath:dataRoot}),normalizeGlobalDataPathForExtension:value=>value,isSoloMapLanguageZh:()=>true,
  growthReports_js_1:require(path.join(root,'out/growthReports.js')),vscode:{window:{showInputBox:async()=> '继续确认导出日期'}},
  captureConversationLaunchTarget:(context,workspaceRoot,globalDataPath,settings)=>captureTarget.runInNewContext({context,workspaceRoot,globalDataPath,settings,path,
   crypto:require('crypto'),syncEngine_1:require(path.join(root,'out/db/syncEngine.js'))}),
  ensureActionProject:async()=>project,waitForAgentProcessCleanup:async()=>{},handleContinueConversationTurn:async(...args)=>launches.push(args)});
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium',headless:true});
 try {
 const errors=[],actions=[];
 const openPage=async()=>{
 const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.route('http://solomap.test/**',async route=>{
  const file=decodeURIComponent(new URL(route.request().url()).pathname);
  assert.ok(file===path.join(root,'resources/logo_with_text.svg') || file.startsWith(path.join(root,'node_modules/@vscode/codicons/dist/')));
  await route.fulfill({path:file});
 });
 await page.exposeFunction('bridge',async m=>{actions.push(m);if(m.command==='growth.reports')await page.evaluate(d=>window.postMessage(d,'*'),{command:'growth.reportsLoaded',projectPath:project,requestId:m.requestId,page:await queryGrowthReports(project,root,{},dataRoot)});if(m.command==='growth.reportTurns')await page.evaluate(d=>window.postMessage(d,'*'),{command:'growth.reportTurnsLoaded',projectPath:project,requestId:m.requestId,taskId:m.taskId,page:await queryGrowthReports(project,root,{taskId:m.taskId},dataRoot)});if(m.command==='growth.reportAction'){await continueAction(m);await page.evaluate(d=>window.postMessage(d,'*'),settled.at(-1));}});
 await page.evaluate(()=>{let state={};window.acquireVsCodeApi=()=>({getState:()=>state,setState:s=>state=s,postMessage:m=>window.bridge(m)});});await page.setContent(html);await page.locator('.report-task').waitFor();
 await page.waitForFunction(()=>document.querySelector('.brand-wordmark')?.naturalWidth>0);
 return page;
 };
 const page=await openPage();
 const failures=[],check=(ok,msg)=>{if(!ok)failures.push(msg);};
 check(await page.locator('.module-card').count() >= 12, 'exercise dense long module names');
 check(!(await page.locator('.report-title').innerText()).includes('原始需求必须按需查看'),'task heading contains full original instructions');
 const visibleSummary=await page.locator('.report-result').innerText();
 check(Array.from(visibleSummary).length<=120 && visibleSummary!==legacySummary,'legacy summary is not condensed in the default layer');
 await page.getByRole('button',{name:'继续处理',exact:true,includeHidden:true}).first().waitFor({state:'attached'});
 check(await page.getByRole('button',{name:'继续处理',exact:true}).first().isVisible(),'latest result is not immediately actionable');
 check(!await page.getByText('关键决策',{exact:true}).first().isVisible(),'process fields are visible by default');
 for(const width of [320,390,600,900,1440]){
 await page.setViewportSize({width,height:900});await page.locator('[data-module-details]').evaluateAll(ns=>ns.forEach(n=>n.open=true));
 const measurements=await page.evaluate(()=>{const panel=document.querySelector('#growth-reports').parentElement,r=panel.getBoundingClientRect(),before=panel.previousElementSibling.getBoundingClientRect(),after=panel.nextElementSibling.getBoundingClientRect();const clipped=[];for(const c of document.querySelectorAll('.module-card')){const b=c.getBoundingClientRect();for(const e of c.querySelectorAll('.module-title,.signal-tag,.module-facts,button,details,p')){const x=e.getBoundingClientRect();if(x.width && (x.right>b.right+1||x.left<b.left-1||x.bottom>b.bottom+1))clipped.push(e.textContent);}}return {gaps:[r.top-before.bottom,after.top-r.bottom],clipped};});
 check(measurements.gaps.every(n=>n>=20),`${width}px report gaps ${measurements.gaps}`);check(!measurements.clipped.length,`${width}px clipped module content: ${measurements.clipped.join(',')}`);
 if(width===390||width===1440){await page.locator('#growth-reports').scrollIntoViewIfNeeded();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await page.screenshot({path:path.join(artifacts,`reports-${width}.png`),animations:'disabled'});await page.locator('.module-matrix').scrollIntoViewIfNeeded();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await page.screenshot({path:path.join(artifacts,`modules-${width}.png`),animations:'disabled'});}
 }
 await page.getByRole('button',{name:'继续处理',exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('.report-actions button:disabled'));
 const continued=actions.filter(m=>m.command==='growth.reportAction');
 check(continued.length===1 && continued[0].kind==='continue' && continued[0].taskId===task.taskId && continued[0].executionLogId===1 && continued[0].turnId===turns.turns[0].turnId, 'continue must target the latest original turn');
 check(launches.length===1 && launches[0][1]==='__solo__' && launches[0][2]===1 && launches[0][3].includes('继续确认导出日期') && launches[0][6]===true,'the real native action must preserve the execution and roadmap state');
 check(settled.length===1 && !settled[0].error,'continue action must settle successfully');
 check(!fs.existsSync(path.join(project,'.solopreneur/agent-runs')),'reading and acting must not recreate the old authority');
 await page.getByText('产出与依据',{exact:true}).first().click();
 check(await page.getByText('关键决策',{exact:true}).first().isVisible(),'evidence must remain available on request');
 check(await page.getByText(legacySummary,{exact:true}).isVisible(),'full legacy summary must remain available on request');
 await page.getByText('较早汇报',{exact:true}).click();
 check(await page.getByText('第1轮汇报',{exact:false}).isVisible(),'older reports must remain accessible');
 const projectId=(await store.registerProject({root:project})).projectId;
 const before=store.readRegisteredReportSources(projectId);
 const original=before.reports.find(report=>report.turnId===turns.turns[0].turnId).sourceRef;
 const replacement=store.write({kind:'report',action:'create',scope:projectId,idempotencyKey:'browser-report-replacement',data:{turn_id:turns.turns[0].turnId,run_id:null,schema_version:1,availability:'available',content:{...body,summary:'日期选择已确认，可以继续完成导出。'}}});
 store.write({kind:'report',action:'archive',scope:projectId,objectId:original.objectId,expectedRevision:original.revision,idempotencyKey:'browser-archive-older-report',data:{}});
 await page.getByRole('button',{name:'全部汇报',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.report-result')?.textContent.includes('日期选择已确认'));
 check(await page.getByText(legacySummary,{exact:true}).count()===0,'manual refresh must replace cached details after archival');
 const notifications=[];
 const reportSourceRevision=store.reportSourceRevision.bind(store);
 store.reportSourceRevision=()=>{throw new Error('first report observation connection failed');};
 const observer=require(path.join(root,'out/growthReportObserver.js')).observeGrowthReports(dataRoot,project,()=>{
  notifications.push('committed-generation');
  void page.evaluate(d=>window.postMessage(d,'*'),{command:'growth.reportsChanged',projectPath:project}).catch(error=>errors.push(error.message));
 });
 page.once('close',()=>observer.dispose());closers.push(()=>observer.dispose());await observer.ready;
 store.reportSourceRevision=reportSourceRevision;
 store.write({kind:'report',action:'patch',scope:projectId,objectId:replacement.objectId,expectedRevision:replacement.revision,idempotencyKey:'browser-native-notification',data:{content:{...body,summary:'日期选择已确认，导出结果已经更新。'}}});
 await page.waitForFunction(()=>document.querySelector('.report-result')?.textContent.includes('导出结果已经更新。'));
 check(notifications.length===1,'a committed native report must refresh the already open page');
 check(await page.getByText(legacySummary,{exact:true}).count()===0,'native refresh must also replace cached details');
 // Reopen the actual webview. Database change notifications are a separate acceptance item.
 const archivePage=await openPage();
 check((await archivePage.locator('.report-result').innerText()).includes('日期选择已确认'),'archiving an older object must retain the latest visible result');
 await archivePage.getByRole('button',{name:'继续处理',exact:true}).click();
 await archivePage.waitForFunction(()=>!document.querySelector('.report-actions button:disabled'));
 check(launches.length===2 && launches[1][3].includes('日期选择已确认') && !launches[1][3].includes(legacySummary),'the visible replacement and continuation must select the same report');
 check(settled.length===2 && !settled[1].error,'replacement continuation must settle successfully');
 store.write({kind:'report',action:'archive',scope:projectId,objectId:replacement.objectId,expectedRevision:replacement.revision+1,idempotencyKey:'browser-archive-latest-report',data:{}});
 const remainingPage=await openPage();
 check((await remainingPage.locator('.report-result').innerText()).includes(body.summary),'archiving all objects in a turn must select the remaining earlier turn');
 await remainingPage.getByRole('button',{name:'继续处理',exact:true}).click();
 await remainingPage.waitForFunction(()=>!document.querySelector('.report-actions button:disabled'));
 check(launches.length===3 && launches[2][3].includes(body.summary) && !launches[2][3].includes('日期选择已确认'),'continuation must use the remaining unarchived result');
 check(settled.length===3 && !settled[2].error,'remaining continuation must settle successfully');
 check(store.readReportVersions(projectId,[original])[0].report.summary===legacySummary,'archived pinned history must retain the full original summary');
 await remainingPage.setViewportSize({width:390,height:900});await remainingPage.locator('#growth-reports').scrollIntoViewIfNeeded();await remainingPage.screenshot({path:path.join(artifacts,'reports-archive-390.png'),animations:'disabled'});
 check(!errors.length,`script errors ${errors}`);check(actions.every(m=>['growth.reports','growth.reportTurns','growth.reportAction'].includes(m.command)),`unexpected effects ${actions.map(m=>m.command)}`);
 fs.writeFileSync(path.join(artifacts,'ui-result.json'),JSON.stringify({failures,errors,requests:actions.map(m=>m.command),nativeTurnId:turns.turns[0].turnId,continuation:{nodeId:launches[0]?.[1],executionLogId:launches[0]?.[2],preserveRoadmapState:launches[0]?.[6]},archival:{replacementContinuation:launches.length===3,remainingEarlierTurn:true,pinnedOriginalReadable:true,changeNotificationsTested:true},notifications,externalAgentLaunched:false},null,2));console.log({artifacts,failures});assert.equal(failures.length,0);
 } finally { await browser.close(); }
 } finally { for(const close of closers.reverse())await close(); }
})().catch(e=>{console.error(e);process.exitCode=1});
