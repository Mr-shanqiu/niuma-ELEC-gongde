import { library, developer } from './free-flow.js';
const languageButton=document.querySelector('.language');
let language=localStorage.getItem('niuma-site-language') || 'zh';
function applyLanguage(){document.documentElement.lang=language==='zh'?'zh-CN':'en'; document.querySelectorAll('[data-zh]').forEach(node=>{const value=node.dataset[language];if(value!==undefined)node.innerHTML=value;});languageButton.textContent=language==='zh'?'EN':'中文';}
languageButton.addEventListener('click',()=>{language=language==='zh'?'en':'zh';localStorage.setItem('niuma-site-language',language);applyLanguage();});applyLanguage();
const stage=document.querySelector('.counter-demo'),total=document.getElementById('demo-total');
function strike(){stage.classList.remove('striking');void stage.offsetWidth;stage.classList.add('striking');stage.querySelector('[data-pack-preview]')?.appearancePlayer?.strike();total.textContent=String(Number(total.textContent)+1);}
document.querySelector('.strike-button').addEventListener('click',strike);
window.NiuMaAppearance.load(stage.querySelector('[data-pack-preview]')).catch(()=>{stage.querySelector('[data-pack-preview]').textContent='演示暂时无法加载，请刷新。';});
const interval=setInterval(strike,4200);addEventListener('pagehide',()=>clearInterval(interval),{once:true});
const observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){entry.target.classList.add('visible');observer.unobserve(entry.target);}},{threshold:.12});document.querySelectorAll('.reveal').forEach(node=>observer.observe(node));
developer();void library();
