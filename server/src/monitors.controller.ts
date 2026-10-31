import type { Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { encrypt, decrypt } from './services/crypto.js';
import { User } from './models/User.js';
import { Monitor } from './models/Monitor.js';
import { CheckResult } from './models/CheckResult.js';
import { Incident } from './models/Incident.js';
import { SavedRequest } from './models/SavedRequest.js';
import { checkSsrf } from './services/ssrf-guard.js';
import { sendTestAlert, getTelegramBot } from './services/alert.js';
import { config } from './config/index.js';
import { createError } from './middleware/errorHandler.js';
import { schedulerService } from './queues/scheduler.js';
import type { AuthRequest } from './middleware/auth.js';

const id = (v: string) => mongoose.isValidObjectId(v);
const safeUser = (u: any) => ({ id: u._id, name: u.name, email: u.email, plan: u.plan, subscriptionStartedAt: u.subscriptionStartedAt || null, proExpiresAt: u.proExpiresAt || null, alertEmail: u.alertEmail, alertPreferences: u.alertPreferences, telegramConnected: Boolean(u.telegramChatId), statusPageSlug: u.statusPageSlug, statusPageEnabled: u.statusPageEnabled, statusPageTitle: u.statusPageTitle, integrations: { telegramConfigured: Boolean(config.telegram.botToken && config.telegram.botUsername), emailConfigured: Boolean(config.smtp.host && config.smtp.user && config.smtp.pass), aiConfigured: Boolean(config.ai.apiKey) } });

export async function overview(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const retentionDays = req.userPlan === 'pro' ? 30 : 7;
    const cutoff = new Date(Date.now() - retentionDays * 86400000);
    const [monitors, openIncidents, checks, recentIncident] = await Promise.all([
      Monitor.find({ userId: req.userId }).sort({ createdAt: -1 }).lean(),
      Incident.countDocuments({ userId: req.userId, status: 'open' }),
      CheckResult.find({ userId: req.userId, checkedAt: { $gte: cutoff } })
        .select('monitorId success classification responseTimeMs checkedAt').lean(),
      Incident.findOne({ userId: req.userId }).sort({ startedAt: -1 }).lean(),
    ]);

    const checksByMonitor = new Map<string, typeof checks>();
    for (const check of checks) {
      const key = String(check.monitorId);
      const bucket = checksByMonitor.get(key) || [];
      bucket.push(check);
      checksByMonitor.set(key, bucket);
    }

    const monitorsWithStats = monitors.map((monitor) => {
      const ownChecks = checksByMonitor.get(String(monitor._id)) || [];
      const successful = ownChecks.filter((c) => c.success || c.classification === 'slow' || c.classification === 'cold_start');
      const responseTimes = ownChecks
        .filter((c) => c.success && c.classification !== 'cold_start' && typeof c.responseTimeMs === 'number')
        .map((c) => c.responseTimeMs as number).sort((a, b) => a - b);
      const p95 = responseTimes.length ? responseTimes[Math.min(responseTimes.length - 1, Math.ceil(.95 * responseTimes.length) - 1)] : null;
      return {
        ...monitor,
        stats: {
          uptimePercent: ownChecks.length ? Number((successful.length / ownChecks.length * 100).toFixed(2)) : null,
          avgResponseTimeMs: responseTimes.length ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length) : null,
          p95ResponseTimeMs: p95,
          checksCount: ownChecks.length,
          retentionDays,
        },
      };
    });

    res.json({
      summary: {
        totalMonitors: monitors.length,
        up: monitors.filter((m) => m.status === 'up').length,
        down: monitors.filter((m) => m.status === 'down').length,
        paused: monitors.filter((m) => m.status === 'paused').length,
        openIncidents,
        retentionDays,
      },
      monitors: monitorsWithStats,
      recentIncident,
    });
  } catch (e) { next(e); }
}
export async function listIncidents(req: AuthRequest,res:Response,next:NextFunction){try{const page=Math.max(1,Number(req.query.page)||1);const limit=Math.min(100,Math.max(1,Number(req.query.limit)||20));const filter:any={userId:req.userId};if(req.query.status)filter.status=req.query.status;if(req.query.monitorId&&id(String(req.query.monitorId)))filter.monitorId=req.query.monitorId;const [incidents,total]=await Promise.all([Incident.find(filter).sort({startedAt:-1}).skip((page-1)*limit).limit(limit).lean(),Incident.countDocuments(filter)]);res.json({incidents,pagination:{page,limit,total,pages:Math.ceil(total/limit)}})}catch(e){next(e)}}
export async function getIncident(req:AuthRequest,res:Response,next:NextFunction){try{if(!id(req.params.id))throw createError('Invalid incident id',400,'INVALID_ID');const incident=await Incident.findOne({_id:req.params.id,userId:req.userId}).lean();if(!incident)throw createError('Incident not found',404,'NOT_FOUND');res.json({incident})}catch(e){next(e)}}
export async function sendTesterRequest(req:AuthRequest,res:Response,next:NextFunction){try{
 const schema=z.object({method:z.enum(['GET','POST','PUT','PATCH','DELETE','HEAD']).default('GET'),url:z.string().url(),headers:z.array(z.object({key:z.string(),value:z.string(),enabled:z.boolean().default(true)})).default([]),body:z.string().optional(),timeoutMs:z.number().int().min(1000).max(30000).default(15000),bodyType:z.enum(['none','json','text']).default('none')});const data=schema.parse(req.body);
 await checkSsrf(data.url);
 const started=Date.now();let status=0, responseHeaders:Record<string,string>={}, responseBody='';let error:string|undefined;
 try{const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),data.timeoutMs);const headers=Object.fromEntries(data.headers.filter(h=>h.enabled&&h.key.trim()).map(h=>[h.key,h.value]));if(data.bodyType==='json'&&!headers['Content-Type'])headers['Content-Type']='application/json';const response=await fetch(data.url,{method:data.method,headers,body:['GET','HEAD'].includes(data.method)||!data.body?undefined:data.body,redirect:'manual',signal:controller.signal});clearTimeout(timer);status=response.status;responseHeaders=Object.fromEntries(response.headers.entries());const raw=await response.text();responseBody=raw.slice(0,1_000_000);}
 catch(e:any){error=e.name==='AbortError'?'Request timed out':e.message||'Request failed'}
 const duration=Date.now()-started;const result={status,time:duration,size:Buffer.byteLength(responseBody),headers:responseHeaders,body:responseBody,error};
 await SavedRequest.create({userId:req.userId,method:data.method,url:data.url,headers:data.headers.map(h=>({...h,value:h.value?encrypt(h.value):''})),body:data.body||'',bodyType:data.bodyType,authType:'none',lastResponseSummary:{statusCode:status||null,responseTimeMs:duration,responseSizeBytes:result.size}}).catch(()=>undefined);
 await SavedRequest.deleteMany({_id:{$in:(await SavedRequest.find({userId:req.userId}).sort({createdAt:-1}).skip(50).select('_id')).map(x=>x._id)}});
 res.json({result});
 }catch(e){next(e)}}
export async function testerHistory(req:AuthRequest,res:Response,next:NextFunction){try{const requests=await SavedRequest.find({userId:req.userId}).sort({createdAt:-1}).limit(50).lean();res.json({requests:requests.map(r=>({...r,headers:(r.headers||[]).map(h=>({...h,value:h.value?'••••••••':''}))}))})}catch(e){next(e)}}
export async function deleteTesterHistory(req:AuthRequest,res:Response,next:NextFunction){try{if(req.params.id){if(!id(req.params.id))throw createError('Invalid request id',400,'INVALID_ID');await SavedRequest.deleteOne({_id:req.params.id,userId:req.userId})}else await SavedRequest.deleteMany({userId:req.userId});res.json({success:true})}catch(e){next(e)}}
export async function updateAccount(req:AuthRequest,res:Response,next:NextFunction){try{const data=z.object({name:z.string().min(2).max(80).optional(),alertEmail:z.string().email().optional(),alertPreferences:z.object({telegram:z.boolean(),email:z.boolean()}).optional()}).parse(req.body);const user=await User.findByIdAndUpdate(req.userId,{$set:data},{new:true,runValidators:true});res.json({user:safeUser(user)})}catch(e){next(e)}}
export async function updateStatusPage(req:AuthRequest,res:Response,next:NextFunction){try{const data=z.object({statusPageEnabled:z.boolean(),statusPageTitle:z.string().min(2).max(80).optional()}).parse(req.body);const current=await User.findById(req.userId);if(!current)throw createError('User not found',404,'NOT_FOUND');if(data.statusPageTitle && data.statusPageTitle !== 'Status Page' && req.userPlan !== 'pro')throw createError('Custom status page titles require Pro. Upgrade to customize your public page.',403,'PLAN_REQUIRED');current.statusPageEnabled=data.statusPageEnabled;if(data.statusPageTitle)current.statusPageTitle=data.statusPageTitle;await current.save();res.json({user:safeUser(current),publicUrl:`/status/${current.statusPageSlug}`})}catch(e){next(e)}}
export async function publicStatus(req: any,res:Response,next:NextFunction){try{const user=await User.findOne({statusPageSlug:req.params.slug,statusPageEnabled:true});if(!user)throw createError('Status page not found',404,'NOT_FOUND');const monitors=await Monitor.find({userId:user._id,showOnStatusPage:true}).select('name url status lastCheckedAt lastResponseTimeMs').lean();const incidents=await Incident.find({userId:user._id}).sort({startedAt:-1}).limit(10).select('startedAt resolvedAt durationSeconds status firstErrorType').lean();res.json({title:user.statusPageTitle,monitors,incidents,updatedAt:new Date()})}catch(e){next(e)}}
export async function upgradePlan(req:AuthRequest,res:Response,next:NextFunction){try{if(!config.demoMode)throw createError('Demo upgrades are disabled',403,'DEMO_DISABLED');const user=await User.findById(req.userId);if(!user)throw createError('User not found',404,'NOT_FOUND');if(user.plan==='pro' && (!user.proExpiresAt || user.proExpiresAt.getTime()>Date.now()))throw createError('Your Pro plan is already active.',409,'PRO_ALREADY_ACTIVE');const now=new Date();user.plan='pro';user.subscriptionStartedAt=now;user.proExpiresAt=new Date(now.getTime()+30*24*60*60*1000);await user.save();await schedulerService.rescheduleUserMonitors(user._id.toString());res.json({user:safeUser(user),message:'Pro activated for 30 days. Demo upgrade, no payment taken.'})}catch(e){next(e)}}
export async function testAlert(req:AuthRequest,res:Response,next:NextFunction){try{const channel=z.enum(['telegram','email']).parse(req.body.channel);await sendTestAlert(req.userId!,channel);res.json({success:true,message:`Test ${channel} alert sent`})}catch(e){next(e)}}
export async function linkTelegram(req:AuthRequest,res:Response,next:NextFunction){try{if(!config.telegram.botUsername)throw createError('Telegram bot is not configured',503,'TELEGRAM_NOT_CONFIGURED');const code=Math.random().toString(36).slice(2,12);await User.findByIdAndUpdate(req.userId,{telegramLinkCode:code,telegramLinkCodeExpiry:new Date(Date.now()+15*60*1000)});res.json({url:`https://t.me/${config.telegram.botUsername}?start=${code}`,expiresInMinutes:15})}catch(e){next(e)}}
export async function unlinkTelegram(req:AuthRequest,res:Response,next:NextFunction){try{await User.findByIdAndUpdate(req.userId,{$set:{telegramChatId:null,telegramLinkCode:null,telegramLinkCodeExpiry:null}});res.json({success:true})}catch(e){next(e)}}
export async function telegramWebhook(req:any,res:Response,next:NextFunction){try{if(config.telegram.mode!=='webhook')throw createError('Telegram webhook mode is not enabled',409,'WEBHOOK_MODE_DISABLED');const bot=getTelegramBot();if(!bot)throw createError('Telegram bot is not configured',503,'TELEGRAM_NOT_CONFIGURED');await bot.processUpdate(req.body);res.status(200).json({ok:true,received:true})}catch(e){next(e)}}
export async function deleteAccount(req:AuthRequest,res:Response,next:NextFunction){try{await Promise.all([Monitor.deleteMany({userId:req.userId}),CheckResult.deleteMany({userId:req.userId}),Incident.deleteMany({userId:req.userId}),SavedRequest.deleteMany({userId:req.userId}),User.deleteOne({_id:req.userId})]);res.clearCookie('token');res.json({success:true})}catch(e){next(e)}}

export async function updatePassword(req:AuthRequest,res:Response,next:NextFunction){try{const data=z.object({currentPassword:z.string().min(1),newPassword:z.string().min(8).max(128)}).parse(req.body);const user=await User.findById(req.userId).select('+passwordHash');if(!user)throw createError('User not found',404,'NOT_FOUND');if(!(await bcrypt.compare(data.currentPassword,user.passwordHash)))throw createError('Current password is incorrect',400,'INVALID_PASSWORD');user.passwordHash=await bcrypt.hash(data.newPassword,12);await user.save();res.json({success:true,message:'Password updated'})}catch(e){next(e)}}
