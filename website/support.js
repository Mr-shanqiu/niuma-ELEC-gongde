import { developer } from './free-flow.js'; developer();
// Old support receipts remain untouched; no order or QR is created.
try{const receipt=JSON.parse(sessionStorage.getItem('niuma-support-pending-checkout')||'null');if(receipt?.orderNo&&receipt?.buyerToken){const link=document.createElement('a');link.href='checkout.html?order='+encodeURIComponent(receipt.orderNo)+'&history=1';link.textContent='查看本浏览器原赞赏记录';document.getElementById('flow-status').after(link);}}catch{}
