/*
  إعدادات ربط موقع حازم ستور بقاعدة البيانات (Firebase)
  ------------------------------------------------------
  طول ما firebase: null الموقع بيشتغل بوضع التجربة (البيانات على الجهاز بس).

  بعد ما تعمل مشروع Firebase (الخطوات بملف README.md):
  1) امسح كلمة null وحط مكانها الكود اللي أعطاك ياه Firebase بين القوسين { }
  2) اكتب إيميل حساب الإدارة في adminEmail
*/
window.HAZEM_CONFIG = {

  firebase: null,

  /* شكل الكود اللي بتلصقه (مثال، الأرقام عندك غير):
  firebase: {
    apiKey: "AIza....",
    authDomain: "hazem-store.firebaseapp.com",
    projectId: "hazem-store",
    storageBucket: "hazem-store.appspot.com",
    messagingSenderId: "1234567890",
    appId: "1:1234567890:web:abcdef123456"
  },
  */

  adminEmail: ""
};
