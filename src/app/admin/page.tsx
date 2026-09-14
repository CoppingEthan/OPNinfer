import { redirect } from "next/navigation";

// The admin area is split into sections (point 3). Land on Users by default.
export default function AdminIndex() {
  redirect("/admin/users");
}
