import dns from 'dns'
dns.setServers(['8.8.8.8', '8.8.4.4'])

import dotenv from 'dotenv'
dotenv.config()

import mongoose from 'mongoose'

async function run() {
  await mongoose.connect(process.env.MONGODB_URI)
  console.log('Connected to MongoDB')

  const result = await mongoose.connection.db.collection('users').updateOne(
    { email: 'jaroli07vatsal@gmail.com' },
    { $set: { isAdmin: true, teacherApprovalStatus: 'approved' } }
  )

  console.log('Matched:', result.matchedCount, '| Modified:', result.modifiedCount)
  if (result.matchedCount === 0) {
    console.log('⚠ No user found with email jaroli07vatsal@gmail.com')
  } else {
    console.log('✅ isAdmin set to true and teacher account approved')
  }

  await mongoose.disconnect()
  process.exit(0)
}

run().catch(e => { console.error('Error:', e.message); process.exit(1) })
