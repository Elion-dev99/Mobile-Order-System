import { db } from './firebase.js';
import { collection, addDoc } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { notifyLeadSubmitted } from './notify.js';

export async function submitLead(payload) {
  const docData = {
    ...payload,
    source: 'lp',
    createdAt: Date.now(),
    status: 'new',
  };
  const ref = await addDoc(collection(db, 'leads'), docData);
  notifyLeadSubmitted({ ...docData, id: ref.id });
  return ref.id;
}
