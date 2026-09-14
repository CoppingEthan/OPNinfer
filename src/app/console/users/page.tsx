import { PageHeader } from "@/components/admin/page-header";
import { getPeople } from "@/lib/console/people";
import { PeopleTable } from "@/components/console/people-table";
import { Unreachable } from "@/components/console/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "People" };

export default async function ConsolePeoplePage() {
  const { people, errors } = await getPeople();
  return (
    <>
      <PageHeader
        title="People"
        subtitle="Every account on every portal, with what it has actually used. After a migration, “password changed” is who has arrived — “last seen” can be a date carried over from the old system."
      />
      <div className="space-y-4">
        <Unreachable errors={errors} />
        <PeopleTable people={people} />
      </div>
    </>
  );
}
